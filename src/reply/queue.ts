/** Ordered, cancellable text/image/file delivery with durable per-unit outcomes. */
import { randomUUID } from 'node:crypto'
import { DEFAULT_REPLY_PLAN, planBubbles, type ReplyPlan } from './bubbles.ts'
import { splitStickerSegments } from '../stickers/markers.ts'
import { RET_THROTTLED } from '../ilink/api.ts'
import type { ConversationStore, DeliveryUnit, DeliveryStatus } from '../chat/history.ts'

export const THROTTLE_CODE = RET_THROTTLED
export function isThrottled(error: unknown): boolean { return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === THROTTLE_CODE }
export interface SendContext { clientId: string; signal: AbortSignal }
export type ReplySender = (peerId: string, text: string, contextToken: string | undefined, context: SendContext) => Promise<void>
export interface ReplyScope { generation: number; activityId: string; signal?: AbortSignal }
export interface DeliveryReport { status: 'accepted' | 'partial' | 'failed' | 'unknown' | 'cancelled'; units: DeliveryUnit[] }
/** 发送时再解析令牌：长任务或退避期间可能已有更新的入站消息。 */
export type ContextTokenSource = string | (() => string | undefined) | undefined
export interface ReplyQueueOptions {
  send: ReplySender
  sendSticker?: (peerId: string, name: string, token: string | undefined, context: SendContext) => Promise<boolean>
  sendFile?: (peerId: string, path: string, token: string | undefined, context: SendContext) => Promise<void>
  history?: ConversationStore
  maxAttempts?: number
  maxThrottleAttempts?: number
  onGiveUp?: (peerId: string, text: string, error: unknown) => void
  retryDelayMs?: number
  minIntervalMs?: number
  plan?: ReplyPlan
  onChunk?: (peerId: string, index: number, total: number) => void
  onDrain?: (peerId: string) => void
  onSlowSend?: (peerId: string, spentMs: number, chars: number) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}
interface Job {
  peerId: string
  units: DeliveryUnit[]
  controller: AbortController
  ready: Promise<void>
  gapMs: number
  /** 每次网络尝试前重新取令牌；没有就用单元上已捕获的那个。 */
  tokenSource?: () => string | undefined
  /** 关键提示：限流时用更长的退避预算，别和普通气泡抢同一条命。 */
  urgent: boolean
  resolve: (report: DeliveryReport) => void
  unlink: () => void
}
function result(units: DeliveryUnit[]): DeliveryReport {
  const statuses = units.map(unit => unit.status)
  const status = statuses.every(status => status === 'accepted') ? 'accepted'
    : statuses.includes('accepted') ? 'partial' : statuses.includes('unknown') ? 'unknown'
      : statuses.includes('failed') ? 'failed' : 'cancelled'
  return { status, units: structuredClone(units) }
}

export class ReplyQueue {
  private readonly queues = new Map<string, Job[]>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly active = new Map<string, Job>()
  private readonly lastSentAt = new Map<string, number>()
  private readonly options: ReplyQueueOptions
  constructor(options: ReplyQueueOptions) { this.options = options }

  enqueue(peerId: string, text: string, contextToken?: ContextTokenSource, plan?: ReplyPlan, options?: { immediate?: boolean; scope?: ReplyScope; groupId?: string; urgent?: boolean }): Promise<DeliveryReport> {
    const selected = plan ?? this.options.plan ?? DEFAULT_REPLY_PLAN
    const parts: { kind: DeliveryUnit['kind']; value: string }[] = []
    // 分条之后再做表情分词：与 markers.ts 共用同一套规则，避免两处漂移。
    for (const bubble of planBubbles(text, selected)) parts.push(...splitStickerSegments(bubble))
    return this.schedule(peerId, parts, contextToken, selected.gapMs, options?.scope, options?.groupId ?? randomUUID(), options?.urgent === true)
  }
  enqueueFiles(peerId: string, paths: readonly string[], token?: ContextTokenSource, scope?: ReplyScope, groupId?: string): Promise<DeliveryReport> {
    return this.schedule(peerId, paths.map(value => ({ kind: 'file', value })), token, 0, scope, groupId ?? randomUUID(), false)
  }
  private schedule(peerId: string, parts: { kind: DeliveryUnit['kind']; value: string }[], token: ContextTokenSource, gapMs: number, scope: ReplyScope | undefined, groupId: string, urgent: boolean): Promise<DeliveryReport> {
    const controller = new AbortController()
    const abort = () => controller.abort(scope?.signal?.reason)
    if (scope?.signal?.aborted) abort()
    else scope?.signal?.addEventListener('abort', abort, { once: true })
    const initialToken = typeof token === 'function' ? token() : token
    const units = parts.map((part, index): DeliveryUnit => ({
      id: `${groupId}:${index}`, peerId, groupId, generation: scope?.generation ?? 0,
      activityId: scope?.activityId ?? 'control', ...part, contextToken: initialToken,
      status: 'pending', createdAt: (this.options.now ?? Date.now)(),
    }))
    return new Promise(resolve => {
      const ready = (async () => { for (const unit of units) await this.options.history?.saveDelivery(unit) })()
      void ready.catch(() => {})
      const job: Job = { peerId, units, controller, ready, gapMs, urgent,
        ...(typeof token === 'function' ? { tokenSource: token } : {}),
        resolve, unlink: () => scope?.signal?.removeEventListener('abort', abort) }
      const queue = this.queues.get(peerId) ?? []
      queue.push(job); this.queues.set(peerId, queue)
      this.ensureDrain(peerId)
    })
  }
  /** Cancel active and queued units. Already accepted units retain their outcome. */
  cancel(peerId: string, activityId?: string): boolean {
    const jobs = [...(this.queues.get(peerId) ?? []), ...(this.active.has(peerId) ? [this.active.get(peerId)!] : [])]
    let cancelled = false
    for (const job of jobs) if (activityId === undefined || job.units.some(unit => unit.activityId === activityId)) {
      if (job.units.some(unit => unit.status === 'pending' || unit.status === 'sending')) { job.controller.abort(); cancelled = true }
    }
    return cancelled
  }
  isBusy(peerId: string): boolean { return this.running.has(peerId) || (this.queues.get(peerId)?.length ?? 0) > 0 }
  async whenIdle(): Promise<void> { while (this.running.size) await Promise.all([...this.running.values()]) }
  /** An interrupted network attempt is ambiguous. Only definitely unattempted units resume. */
  async recover(): Promise<void> {
    if (!this.options.history) return
    for (const peerId of await this.options.history.peers()) {
      const history = await this.options.history.history(peerId)
      const interrupted = new Set(history.deliveries.filter(unit => unit.status === 'sending').map(unit => unit.groupId))
      for (const unit of history.deliveries) {
        if (unit.status === 'sending') await this.options.history.saveDelivery({ ...unit, status: 'unknown', error: '进程在发送期间退出，投递结果不明' })
        else if (unit.status === 'pending') {
          // Do not resurrect an old answer in a new activity. Expose the outcome to the next request.
          await this.options.history.saveDelivery({ ...unit, status: 'cancelled', error: interrupted.has(unit.groupId) ? '前一条投递结果不明，取消剩余内容' : '重启取消尚未发送的旧回复' })
        }
      }
    }
  }
  private ensureDrain(peerId: string): void {
    if (this.running.has(peerId)) return
    const work = this.drain(peerId).finally(() => {
      this.running.delete(peerId)
      if (this.queues.get(peerId)?.length) this.ensureDrain(peerId)
    })
    this.running.set(peerId, work)
  }
  private async drain(peerId: string): Promise<void> {
    try {
      for (;;) {
        const job = this.queues.get(peerId)?.shift()
        if (!job) { this.queues.delete(peerId); return }
        this.active.set(peerId, job)
        try { await this.deliver(job) }
        catch (error) {
          for (const unit of job.units) if (unit.status === 'pending') { unit.status = 'failed'; unit.error = String(error) }
          this.options.onGiveUp?.(peerId, '', error)
        } finally { this.active.delete(peerId); job.unlink(); job.resolve(result(job.units)) }
      }
    } finally { this.options.onDrain?.(peerId) }
  }
  private async save(unit: DeliveryUnit, status: DeliveryStatus, error?: string): Promise<void> {
    unit.status = status
    if (error) unit.error = error
    await this.options.history?.saveDelivery(unit)
  }
  private async pause(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || ms <= 0) return
    if (this.options.sleep) { await this.options.sleep(ms); return }
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
      const timer = setTimeout(finish, ms)
      signal.addEventListener('abort', finish, { once: true })
    })
  }
  private async deliver(job: Job): Promise<void> {
    // Commit the complete group before the first network attempt.
    await job.ready
    let stop = false
    for (const [index, unit] of job.units.entries()) {
      if (job.controller.signal.aborted || stop) {
        // 分清“用户取消”和“前一项失败导致没轮到”：后者属于可补发内容。
        await this.save(unit, 'cancelled', stop ? '前一条未发出，已取消' : undefined)
        continue
      }
      if (index) await this.pause(job.gapMs, job.controller.signal)
      this.options.onChunk?.(job.peerId, index, job.units.length)
      const sent = await this.send(job, unit, job.controller.signal)
      // A missing sticker should not suppress meaningful following text.
      if (!sent && unit.kind !== 'sticker') stop = true
    }
  }
  private async send(job: Job, unit: DeliveryUnit, signal: AbortSignal): Promise<boolean> {
    let attempts = 0, throttles = 0
    for (;;) {
      const last = this.lastSentAt.get(unit.peerId)
      if (last !== undefined) await this.pause(Math.max(0, (this.options.minIntervalMs ?? 0) - ((this.options.now ?? Date.now)() - last)), signal)
      if (signal.aborted) { await this.save(unit, 'cancelled'); return false }
      // 每次尝试前刷新令牌：限流退避期间用户可能又发了消息，旧令牌未必还能用。
      if (job.tokenSource !== undefined) unit.contextToken = job.tokenSource() ?? unit.contextToken
      await this.save(unit, 'sending')
      if (signal.aborted) { await this.save(unit, 'cancelled'); return false }
      try {
        const started = (this.options.now ?? Date.now)()
        const context = { clientId: unit.id, signal }
        if (unit.kind === 'text') await this.options.send(unit.peerId, unit.value, unit.contextToken, context)
        else if (unit.kind === 'file') {
          if (!this.options.sendFile) throw Object.assign(new Error('宿主不支持文件发送'), { code: 'unsupported' })
          await this.options.sendFile(unit.peerId, unit.value, unit.contextToken, context)
        } else if (!this.options.sendSticker || !(await this.options.sendSticker(unit.peerId, unit.value, unit.contextToken, context))) {
          await this.save(unit, 'failed', '表情不存在或不可发送'); return false
        }
        // An accepted send remains accepted even when cancellation raced its response.
        await this.save(unit, 'accepted')
        const spent = (this.options.now ?? Date.now)() - started
        if (spent > 1000) this.options.onSlowSend?.(unit.peerId, spent, unit.value.length)
        this.lastSentAt.set(unit.peerId, (this.options.now ?? Date.now)())
        return true
      } catch (error) {
        const failure = error as { code?: unknown; status?: unknown }
        const rejected = typeof failure?.code === 'number' || ['unsupported', 'ENOENT', 'EACCES'].includes(String(failure?.code)) || (typeof failure?.status === 'number' && failure.status >= 400 && failure.status < 500)
        if (signal.aborted) { await this.save(unit, rejected ? 'cancelled' : 'unknown', String(error)); return false }
        if (isThrottled(error) && throttles < (job.urgent ? 8 : (this.options.maxThrottleAttempts ?? 6))) {
          // 线上 -2 会持续几十秒；关键提示等得更久一点，普通气泡不长期占着队列。
          throttles++
          await this.pause(Math.min(job.urgent ? 20_000 : 30_000, 2000 * 2 ** (throttles - 1)), signal)
          continue
        }
        attempts++
        if ((rejected && !isThrottled(error)) || attempts >= (this.options.maxAttempts ?? 3)) {
          await this.save(unit, rejected ? 'failed' : 'unknown', String(error))
          this.options.onGiveUp?.(unit.peerId, unit.value, error)
          return false
        }
        await this.pause(this.options.retryDelayMs ?? 1000, signal)
      }
    }
  }
}
