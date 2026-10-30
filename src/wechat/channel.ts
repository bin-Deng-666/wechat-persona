/** WeChat ingress and DSH event routing. Each contact owns its conversation lifecycle. */
import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import { asWeixinMessage, BusinessError, ERRCODE_SESSION_EXPIRED, type ApiClient } from '../ilink/api.ts'
import { describeInbound, needsDiagnosis, summarizeRaw } from '../ilink/diagnose.ts'
import type { MessageItem, WeixinMessage } from '../ilink/types.ts'
import type { AccessPolicy } from './access.ts'
import type { ActivityStore } from '../chat/activity.ts'
import { ConversationStore, type InboundRecord, type AgentBatch } from '../chat/history.ts'
import { PeerConversation, type ConversationActivity } from '../chat/conversation.ts'
import { DEFAULT_REPLY_PLAN, resolvePlan, type ReplyPlan } from '../reply/bubbles.ts'
import { expandLocationTokens } from '../text/location.ts'
import { ChatControls } from './controls.ts'
import type { ModelCatalog } from './controls.ts'
import type { PreparedMedia } from '../dsh/attachments.ts'
import type { CompactOutcome } from '../dsh/compaction.ts'
import type { ReplyQueue, DeliveryReport, ReplyPriority } from '../reply/queue.ts'
import { extractAssistantText, extractProgressText, extractToolName } from '../dsh/events.ts'
import { PeerSessions, sessionIdFor } from '../dsh/sessions.ts'
import { PersonaStore } from '../persona/store.ts'
import { DEFAULT_CHAT_SETTINGS, type ChatSettings, type ChatSettingsStore } from '../chat/settings.ts'
import { extractStickerAnnotations } from '../stickers/markers.ts'
import type { StickerLibrary } from '../stickers/library.ts'
import { parseCommand } from './commands.ts'
import { createNoticePicker, noticesFor } from './notices.ts'
import type { PeerGenerations } from '../chat/generations.ts'
import { SerialWork } from '../storage/atomic.ts'
import type { PeerMemory } from '../memory/store.ts'
import type { MemoryActivity } from '../memory/capture.ts'

export interface ChannelAccount { baseUrl: string; token: string; userId?: string }
export interface SessionEventsLike { on(event: 'session/event', listener: (session: { id: unknown }, event: unknown) => void): () => void }
/**
 * 报平安的默认节奏：90 秒一句，最多持续 900 秒。
 *
 * 60 秒实测仍然偏密——10:28 那轮连发 9 条后，紧接着的真答案撞上 -2 限流丢了。
 * 90 秒 × 10 = 900 秒，仍然等于人格卡要求的最小文案条数（`persona/card.ts` 的
 * `MIN_PROGRESS_LINES`），一轮用完不重样，但每分钟的密度降下来了。
 *
 * ⚠️ 改这两个值之前先读 `test/wechat/notices.test.ts` 里的配额断言：它会拦住
 * 「一轮配额超过文案条数」的改法，否则用户会在一轮里看到重复的句子。
 */
export const DEFAULT_NOTICE_INTERVAL_MS = 90_000
export const DEFAULT_NOTICE_WINDOW_MS = 900_000
const PROGRESS_MIN_GAP_MS = 4_000
const TOOL_PROGRESS_AFTER_MS = 15_000

export interface ChannelOptions {
  api: ApiClient
  account: ChannelAccount
  sessions: PeerSessions
  access: AccessPolicy
  personas: PersonaStore
  defaultPersona: string
  replies: ReplyQueue
  events: SessionEventsLike
  history?: ConversationStore
  report?: (line: string, detail?: unknown) => void
  onSessionExpired?: () => void
  sleep?: (ms: number) => Promise<void>
  pollTimeoutMs?: number
  maxBackoffMs?: number
  now?: () => number
  settings?: ChatSettingsStore
  /** 宿主模型目录；缺失时设置菜单不提供换模型。 */
  catalog?: () => Promise<ModelCatalog | undefined>
  generations?: PeerGenerations
  compact?: (peerId: string, generation: number, signal?: AbortSignal) => Promise<CompactOutcome>
  /** 一轮结束时把会话 id 交给宿主（用于归入工作区）；缺失表示不需要。 */
  onSessionSettled?: (sessionId: string) => void
  /** 逐条记录入站报文形状；用来调查协议未公开场景（例如群聊）。 */
  diagnoseMessages?: boolean | (() => boolean)
  permissionLabel?: string
  typing?: { start: (peerId: string, contextToken?: string) => Promise<unknown>; stop: (peerId: string) => Promise<unknown> }
  approvals?: { answer: (peerId: string, text: string) => boolean; cancel: (peerId: string, why?: string) => void }
  cwd?: string
  prepareMedia?: (items: readonly MessageItem[], peerId?: string, signal?: AbortSignal) => Promise<PreparedMedia>
  activity?: ActivityStore
  memory?: PeerMemory
  stickers?: Pick<StickerLibrary, 'names' | 'annotate' | 'adoptLatest'>
  mergeWindowMs?: number
  /** 交给宿主后多久仍无进展就主动告知用户；0 关闭。 */
  stallAfterMs?: number
  /**
   * 干活期间隔多久报一句平安，毫秒；默认 60_000，0 关闭。
   *
   * 报平安的句子来自人格卡的 `progress`，没写就用内置库。
   */
  noticeIntervalMs?: number
  /**
   * 报平安最多持续多久（从交给宿主算起），默认 600 秒。
   *
   * 这是「一轮上限」的来源：上限 = ceil(窗口 / 间隔)，跟着节奏一起变，
   * 而不是另写一个死数字——改间隔时不会立刻把配额打满。
   * 超过窗口就安静下来，长任务交给卡住看门狗兜底。
   *
   * 默认值和人格卡的 10 条文案是一对：60 秒 × 10 = 600 秒，
   * 正好一轮用完不重样。改这里要看 `persona/card.ts` 的 `MIN_PROGRESS_LINES`。
   */
  noticeWindowMs?: number
}
export function textOf(message: WeixinMessage): string {
  return (message.item_list ?? []).flatMap(item => item.type === 1 && typeof item.text_item?.text === 'string' ? [item.text_item.text]
    : item.type === 3 && item.voice_item?.text ? [item.voice_item.text] : []).join('\n').trim()
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export class Channel {
  private readonly history: ConversationStore
  private readonly conversations = new Map<string, Promise<PeerConversation>>()
  private readonly states = new Map<string, PeerConversation>()
  private readonly routes = new Map<string, { conversation: PeerConversation; generation: number }>()
  private readonly contextTokens = new Map<string, string>()
  private readonly plans = new Map<string, ReplyPlan>()
  private readonly jobs = new Set<Promise<unknown>>()
  private readonly eventWork = new Map<string, SerialWork>()
  private eventQueue(peerId: string): SerialWork { let queue = this.eventWork.get(peerId); if (!queue) { queue = new SerialWork(); this.eventWork.set(peerId, queue) } return queue }
  private readonly stalls = new Map<string, NodeJS.Timeout>()
  /** 每个联系人干活期间「报平安」的定时器与取句器。 */
  private readonly notices = new Map<string, { timer: NodeJS.Timeout; activityId: string; next: () => string | undefined; sent: number; deadline: number }>()
  /** 同一轮相同旁白只发一次；过短的两条更新合并时间，避免工具步骤刷屏。 */
  private readonly progressUpdates = new Map<string, { text: string; at: number }>()
  private readonly toolUpdates = new Map<string, { name: string; at: number }>()
  private readonly deliveryWarnings = new Set<string>()
  /** 每个联系人当前该用哪套句子；在解析人格卡时写入。 */
  private readonly noticeLines = new Map<string, readonly string[]>()
  private readonly turnCounts = new Map<string, number>()
  private readonly activity: ActivityStore
  private readonly controls: ChatControls
  private running = false
  private closed = false
  private abort: AbortController | undefined
  private unsubscribe: (() => void) | undefined
  private cursor: string | undefined
  private readonly sleep: (ms: number) => Promise<void>
  private readonly options: ChannelOptions
  constructor(options: ChannelOptions) {
    this.options = options
    this.history = options.history ?? new ConversationStore()
    this.sleep = options.sleep ?? (async ms => { await new Promise(resolve => setTimeout(resolve, ms)) })
    const activity = new Map<string, number>()
    this.activity = options.activity ?? { get: peer => activity.get(peer), touch: (peer, at) => { activity.set(peer, at) }, peers: () => [...activity.keys()] }
    this.controls = new ChatControls({ ...options,
      scopeFor: peer => this.states.get(peer)?.controlScope(),
      planFor: peer => this.plans.get(peer),
      lastSeen: peer => this.activity.get(peer),
      contextTokenFor: peer => this.contextTokens.get(peer),
      runBackground: task => { this.track(task) },
      turnsFor: peer => this.turnCounts.get(peer) ?? 0,
      cancelTurn: async peer => await this.stopConversation(await this.conversation(peer)),
      retryDelivery: async peer => await this.retryDelivery(peer),
      selectModel: async (peer, generation, choice) => await this.selectModel(peer, generation, choice),
      newConversation: async peer => await this.newConversation(await this.conversation(peer)),
      compactConversation: async peer => await this.compactConversation(await this.conversation(peer)),
      sendSticker: async (peer, name, token) => {
        const report = await options.replies.enqueue(peer, `[表情:${name}]`, token, undefined, { immediate: true })
        if (report.status === 'accepted') return true
        if (report.status === 'failed' && report.units.every(unit => unit.error === '表情不存在或不可发送')) return false
        return report.status === 'unknown' ? 'unknown' : 'failed'
      },
    })
  }
  private conversation(peerId: string): Promise<PeerConversation> {
    let pending = this.conversations.get(peerId)
    if (!pending) {
      pending = (async () => { const state = new PeerConversation(peerId, await this.options.generations?.get(peerId) ?? 0); this.states.set(peerId, state); return state })()
      this.conversations.set(peerId, pending)
    }
    return pending
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.jobs.add(promise)
    void promise.catch(error => { this.options.report?.('对话工作失败', { error: String(error) }) }).finally(() => { this.jobs.delete(promise) })
    return promise
  }
  async run(initialCursor?: string): Promise<void> {
    this.cursor = initialCursor; this.running = true; this.closed = false; this.abort = new AbortController()
    this.subscribeReplies()
    await this.activity.load?.()
    await this.options.replies.recover()
    await this.recoverInputs()
    let timeout = this.options.pollTimeoutMs ?? 4000, backoff = 1000
    while (this.running) {
      const start = (this.options.now ?? Date.now)()
      try {
        const result = await this.options.api.getUpdates({ baseUrl: this.options.account.baseUrl, endpoint: 'ilink/bot/getupdates', label: 'getupdates', token: this.options.account.token,
          ...(this.cursor === undefined ? {} : { cursor: this.cursor }), timeoutMs: timeout, signal: this.abort.signal })
        backoff = 1000
        // handle acknowledges durable acceptance, never waits for a model, media download or send.
        for (const raw of result.msgs) await this.handle(raw, true)
        if (result.get_updates_buf !== undefined) this.cursor = result.get_updates_buf
        if (result.longpolling_timeout_ms && result.longpolling_timeout_ms > 0) timeout = Math.min(timeout, result.longpolling_timeout_ms)
        const spent = (this.options.now ?? Date.now)() - start
        if (!result.msgs.length && spent < 500) await this.sleep(500 - spent)
      } catch (error) {
        if (!this.running) break
        if ((error as { classification?: { type?: string } })?.classification?.type === 'timeout') continue
        if (error instanceof BusinessError && error.code === ERRCODE_SESSION_EXPIRED) { this.running = false; this.options.onSessionExpired?.(); break }
        this.options.report?.('轮询失败，稍后重试', { error: String(error) })
        await this.sleep(backoff); backoff = Math.min(this.options.maxBackoffMs ?? 60000, backoff * 2)
      }
    }
    this.unsubscribe?.(); this.unsubscribe = undefined
  }
  /** Direct callers may wait for a zero-window batch; polling only waits for the durable inbox. */
  async handle(raw: unknown, receiveOnly = false): Promise<void> {
    if (this.closed) return
    this.subscribeReplies()
    // 诊断打在「校验之前」：协议没公开的场景（例如群聊）往往就是在这里被静默丢掉的。
    const shape = describeInbound(raw)
    if (shape === undefined) {
      this.options.report?.('忽略了一条无法识别的入站报文', { raw: summarizeRaw(raw) })
      return
    }
    const verbose = typeof this.options.diagnoseMessages === 'function' ? this.options.diagnoseMessages() : this.options.diagnoseMessages === true
    if (needsDiagnosis(shape, verbose)) this.options.report?.('入站报文形状', shape)
    const message = asWeixinMessage(raw)
    if (!message || (message.message_type !== undefined && message.message_type !== 1)) {
      if (verbose) this.options.report?.('忽略了非用户消息', { messageType: shape.messageType, fromId: shape.fromId })
      return
    }
    const peerId = message.from_user_id ?? ''
    if (!peerId) return
    if (!this.options.access.admits(peerId)) {
      this.options.report?.('拒绝了一个不在名单里的 peer', { peerId, toId: shape.toId, messageType: shape.messageType, itemTypes: shape.itemTypes })
      return
    }
    const conversation = await this.conversation(peerId)
    await this.track(conversation.accept(async () => {
      const received = await this.history.receive(peerId, conversation.generation, message, textOf(message), (this.options.now ?? Date.now)())
      if (received.fresh) await this.dispatch(conversation, received.record)
    }))
    if (!receiveOnly && (this.options.mergeWindowMs ?? 650) <= 0) await conversation.whenIdle()
  }
  private async dispatch(conversation: PeerConversation, record: InboundRecord): Promise<void> {
    if (this.closed) return
    const { peerId } = conversation
    this.activity.touch(peerId, (this.options.now ?? Date.now)())
    const token = record.raw.context_token
    if (token) this.contextTokens.set(peerId, token)
    void this.options.typing?.start(peerId, token)
    if (this.options.approvals?.answer(peerId, record.text)) { await this.history.inputStatus(peerId, [record.id], 'control'); return }
    // 菜单是一次性点击：只有有效期内的单个数字被消费，其余消息照常进模型。
    try {
      if (await this.controls.consumeMenu(peerId, record.text, conversation.generation)) {
        await this.history.inputStatus(peerId, [record.id], 'control')
        return
      }
    } catch (error) {
      await this.history.inputStatus(peerId, [record.id], 'control')
      this.options.report?.('菜单操作未完成', { peerId, error: String(error) })
      this.notice(conversation, '这次设置未能完成，请重新发送「设置」再试。')
      return
    }
    const command = parseCommand(record.text)
    if (command) {
      await this.history.inputStatus(peerId, [record.id], 'control')
      const execute = async () => {
        try {
          await this.controls.execute(peerId, command, conversation.generation, token)
          await this.history.notice(peerId, `用户执行设置指令：${record.text}`)
        } catch (error) {
          this.options.report?.('微信指令未完成', { peerId, command: command.name, error: String(error) })
          this.notice(conversation, '这次设置没能完成，可以再试一次。')
        }
      }
      // Commands share one executor; only long-running work leaves the ingress lane.
      if (command.name === 'compact' || (command.name === '表情' && ['发', '发送'].includes(command.args[0] ?? ''))) this.track(execute())
      else await execute()
      return
    }
    if (!(await this.settingsFor(peerId)).enabled) { await this.history.inputStatus(peerId, [record.id], 'cancelled'); return }
    if (conversation.activity?.phase === 'compacting') conversation.invalidate()
    conversation.pending.push(record)
    // 同一轮里追加：只是记下「还有输入没被认领」。
    // 不要在这里作废当前输出作用域——那条回答已经生成，作废它等于让用户白等一场。
    if (conversation.busy()) conversation.activity?.pendingMessages.add(`input:${record.id}`)
    if (conversation.timer) clearTimeout(conversation.timer)
    const window = this.options.mergeWindowMs ?? 650
    if (window <= 0) { this.track(this.flush(conversation)); return }
    const remaining = Math.max(0, 1800 - ((this.options.now ?? Date.now)() - conversation.pending[0]!.receivedAt))
    conversation.timer = setTimeout(() => { conversation.timer = undefined; this.track(this.flush(conversation)) }, Math.min(window, remaining))
    conversation.timer.unref?.()
  }
  private settingsFor(peer: string): Promise<ChatSettings> { return this.options.settings?.get(peer) ?? Promise.resolve(DEFAULT_CHAT_SETTINGS) }
  private async flush(conversation: PeerConversation): Promise<void> {
    if (conversation.timer) clearTimeout(conversation.timer)
    conversation.timer = undefined
    const records = conversation.pending.splice(0)
    if (!records.length) return
    const epoch = conversation.epoch
    await conversation.schedule(async () => {
      if (this.closed) return
      if (epoch !== conversation.epoch) { await this.history.inputStatus(conversation.peerId, records.map(record => record.id), 'cancelled'); return }
      const activity = conversation.begin(records, (this.options.now ?? Date.now)())
      const settings = await this.settingsFor(conversation.peerId)
      const card = PersonaStore.resolve(settings.personaId ?? this.options.defaultPersona, await this.options.personas.snapshot())
      this.plans.set(conversation.peerId, resolvePlan(card, settings))
      this.noticeLines.set(conversation.peerId, noticesFor(card))
      const content: { type: string; [key: string]: unknown }[] = []
      const addText = (text: string) => {
        if (!text) return
        const last = content.at(-1)
        if (last?.type === 'text') last.text = `${last.text}\n${text}`
        else content.push({ type: 'text', text })
      }
      try {
        for (const record of records) {
          for (const item of record.raw.item_list ?? []) {
            if (item.type === 1 && item.text_item?.text) { addText(item.text_item.text); continue }
            if (item.type === 3 && item.voice_item?.text) { addText(item.voice_item.text); continue }
            if (this.options.prepareMedia) {
              const media = await this.options.prepareMedia([item], conversation.peerId, activity.signal)
              for (const note of media.notes) addText(note)
              content.push(...media.parts as typeof content)
            }
          }
        }
        if (this.closed) return
        if (activity.signal.aborted || epoch !== conversation.epoch) { await this.history.inputStatus(conversation.peerId, records.map(record => record.id), 'cancelled'); return }
        if (!content.length) addText('（收到一条无法读取的消息）')
        const id = `wx_batch_${createHash('sha256').update(records.map(record => record.id).join('\0')).digest('hex')}`
        const batch: AgentBatch = { id, activityId: activity.id, generation: conversation.generation, inputIds: records.map(record => record.id), content, status: 'pending' }
        await this.history.saveBatch(conversation.peerId, batch)
        await this.submitBatch(conversation, activity, batch)
      } catch (error) {
        this.clearProgress(conversation.peerId)
        this.options.report?.('投递给模型失败', { peerId: conversation.peerId, error: String(error) })
        if (!activity.signal.aborted) this.notice(conversation, '这条暂时没接上，消息已保留。可以重试或开新对话。', activity)
      }
    })
  }
  private async submitBatch(conversation: PeerConversation, activity: ConversationActivity, batch: AgentBatch): Promise<void> {
    const { peerId } = conversation
    for (const id of batch.inputIds) activity.pendingMessages.delete(`input:${id}`)
    activity.pendingMessages.add(batch.id)
    this.routes.set(sessionIdFor(peerId, conversation.generation), { conversation, generation: conversation.generation })
    await this.history.inputStatus(peerId, batch.inputIds, 'submitted', batch.id)
    conversation.markSubmitted((this.options.now ?? Date.now)())
    const message = freezeMessage({ id: batch.id, role: 'user', content: batch.content, source: { kind: 'user' } } as never)
    await this.options.sessions.deliver(peerId, message as never, conversation.generation)
    batch.status = 'submitted'; await this.history.saveBatch(peerId, batch)
    // 宿主接下了这一批：从现在开始等它开轮，超时就主动报「卡住了」。
    this.armStallWatch(conversation, activity)
    this.startNotices(conversation, activity)
    this.reportLeg(conversation.peerId, 'submitted', activity)
    this.activity.touch(peerId, (this.options.now ?? Date.now)())
    this.turnCounts.set(peerId, (this.turnCounts.get(peerId) ?? 0) + 1)
  }

  /**
   * 分段计时：把「收到 → 入队 → 回合开始 → 首个正文 → 出站」逐段写进日志。
   *
   * 之前这条链路只在两端打点，中间一片空白，出问题时无法判断是哪一环在等。
   */
  private reportLeg(peerId: string, leg: string, activity: ConversationActivity): void {
    const now = (this.options.now ?? Date.now)()
    this.options.report?.(`时序 ${leg}`, {
      peerId: peerId.slice(0, 12),
      activity: activity.id.slice(0, 8),
      sinceReceived: now - activity.at.created,
      ...(activity.at.started === undefined ? {} : { queuedFor: activity.at.started - (activity.at.submitted ?? activity.at.created) }),
    })
  }

  /**
   * 卡住看门狗。
   *
   * 交给宿主后如果一直没有 turn/start（或一直没有正文），用户那边是完全静默的。
   * 这里在超过截止时间后主动告诉用户一声，并把当时的阶段一起记进日志，
   * 而不是让它无声地挂着。
   */
  private armStallWatch(conversation: PeerConversation, activity: ConversationActivity): void {
    this.disarmStallWatch(conversation.peerId)
    const deadline = this.options.stallAfterMs ?? 120_000
    if (deadline <= 0) return
    const timer = setTimeout(() => {
      this.stalls.delete(conversation.peerId)
      if (conversation.activity !== activity || activity.signal.aborted) return
      if (activity.at.ended !== undefined) return
      this.options.report?.('等待过久', {
        peerId: conversation.peerId.slice(0, 12),
        activity: activity.id.slice(0, 8),
        phase: activity.phase,
        spent: (this.options.now ?? Date.now)() - activity.at.created,
        started: activity.at.started !== undefined,
      })
      this.notice(conversation, activity.at.started === undefined
        ? '这条还没轮到模型处理，已经排了很久。可以稍等，也可以发「停止」再重发。'
        : '这一轮跑得比较久，还没有结果。可以继续等，也可以发「停止」。', activity)
    }, deadline)
    timer.unref?.()
    this.stalls.set(conversation.peerId, timer)
  }

  private disarmStallWatch(peerId: string): void {
    const timer = this.stalls.get(peerId)
    if (timer) clearTimeout(timer)
    this.stalls.delete(peerId)
  }
  private async recoverInputs(): Promise<void> {
    for (const peerId of await this.history.peers()) {
      if (!this.options.access.admits(peerId)) continue
      const conversation = await this.conversation(peerId)
      const state = await this.history.history(peerId)
      for (const batch of state.batches.filter(batch => batch.status !== 'cancelled' && batch.generation === conversation.generation)) {
        if (batch.status !== 'pending') continue
        const records = state.inputs.filter(input => batch.inputIds.includes(input.id))
        const activity = conversation.begin(records, (this.options.now ?? Date.now)())
        this.track(conversation.schedule(async () => { await this.submitBatch(conversation, activity, batch) }))
      }
      for (const record of state.inputs.filter(input => input.status === 'received')) {
        if (record.generation !== conversation.generation) await this.history.inputStatus(peerId, [record.id], 'cancelled')
        else this.track(this.dispatch(conversation, record))
      }
    }
  }
  private async stopConversation(conversation: PeerConversation): Promise<boolean> {
    const pending = [...conversation.pending]
    const active = conversation.invalidate()
    const output = this.options.replies.cancel(conversation.peerId)
    this.clearProgress(conversation.peerId)
    this.stopNotices(conversation.peerId)
    await this.history.cancelTask(conversation.peerId, conversation.generation)
    this.options.approvals?.cancel(conversation.peerId, '用户停止')
    const cancelled = await this.options.sessions.cancel?.(conversation.peerId, conversation.generation) ?? false
    if (pending.length) await this.history.inputStatus(conversation.peerId, pending.map(record => record.id), 'cancelled')
    const state = await this.history.history(conversation.peerId)
    for (const batch of state.batches.filter(batch => batch.generation === conversation.generation && batch.status === 'pending')) await this.history.saveBatch(conversation.peerId, { ...batch, status: 'cancelled' })
    await this.history.notice(conversation.peerId, '用户停止了当前任务和未发送内容')
    return active || output || cancelled || pending.length > 0
  }
  /** 会话内热切换模型；宿主或会话不支持时返回 false，让设置页回退到新会话。 */
  private async selectModel(peerId: string, generation: number, choice: { provider: string; model: string }): Promise<boolean> {
    if (this.options.sessions.selectModel === undefined) return false
    try {
      return await this.options.sessions.selectModel(peerId, generation, choice)
    } catch (error) {
      this.options.report?.('会话内切换模型失败', { peerId, error: String(error) })
      return false
    }
  }

  private async newConversation(conversation: PeerConversation): Promise<number> {
    await this.stopConversation(conversation)
    if (!this.options.generations) throw new Error('这个部署没有开启多段对话')
    conversation.generation = await this.options.generations.bump(conversation.peerId)
    conversation.activity = undefined
    await this.history.notice(conversation.peerId, `用户开启第 ${conversation.generation + 1} 段新对话`)
    return conversation.generation
  }
  private async compactConversation(conversation: PeerConversation): Promise<CompactOutcome> {
    if (!this.options.compact) return { kind: 'unavailable' }
    if (conversation.activity?.phase === 'running') return { kind: 'busy' }
    const activity = conversation.begin([], (this.options.now ?? Date.now)()); activity.phase = 'compacting'
    try { return await this.options.compact(conversation.peerId, conversation.generation, activity.signal) }
    finally { if (!activity.signal.aborted) activity.phase = 'idle' }
  }
  private notice(conversation: PeerConversation, text: string, activity?: ConversationActivity, urgent = false, priority: ReplyPriority = urgent ? 'high' : 'normal'): void {
    const plan = this.plans.get(conversation.peerId) ?? DEFAULT_REPLY_PLAN
    const scope = activity ? conversation.scope(activity) : conversation.controlScope()
    this.track(this.eventQueue(conversation.peerId).run(async () => {
      if (scope?.signal?.aborted) return
      // 真正发送时再取令牌：排队期间来了新消息，就用新的，别拿几分钟前的。
      const token = () => this.contextTokens.get(conversation.peerId) ?? activity?.contextToken
      const delivery = this.options.replies.enqueue(conversation.peerId, text, token, { ...plan, splitMode: 'none' }, { immediate: true, scope, priority })
      if (urgent) {
        // 关键提示若最终没发出去，写进持久上下文：下一次对话由模型自然带出，而不是彻底静默。
        this.track(delivery.then(async report => {
          if (report.status === 'accepted') return
          await this.history.notice(conversation.peerId, `未能送达用户的提示：${text}`)
        }))
        return
      }
      this.track(delivery)
    }))
  }
  private clearProgress(peerId: string): void {
    this.progressUpdates.delete(peerId)
    this.toolUpdates.delete(peerId)
  }

  /** 发送真实阶段说明，不再拿随机短句冒充任务进展。 */
  private progressNotice(conversation: PeerConversation, activity: ConversationActivity, text: string): void {
    const now = (this.options.now ?? Date.now)()
    const previous = this.progressUpdates.get(conversation.peerId)
    if (previous?.text === text || (previous !== undefined && now - previous.at < PROGRESS_MIN_GAP_MS)) return
    this.progressUpdates.set(conversation.peerId, { text, at: now })
    // 旁白是 low：回答一旦排队，它就自动让路，不占限流预算。
    this.notice(conversation, text, activity, false, 'low')
    // 有实质内容时停止空泛的报平安；后续仍无正文则由低频兜底接管。
    this.stopNotices(conversation.peerId)
    this.startNotices(conversation, activity)
  }

  /** 工具事件仅用于没有旁白时的低频心跳，不公开参数、路径或输出。 */
  private toolProgress(conversation: PeerConversation, activity: ConversationActivity, name: string): void {
    const now = (this.options.now ?? Date.now)()
    const previous = this.toolUpdates.get(conversation.peerId)
    if (previous !== undefined && (previous.name !== name || now - previous.at < TOOL_PROGRESS_AFTER_MS)) return
    this.toolUpdates.set(conversation.peerId, { name, at: now })
    this.progressNotice(conversation, activity, `正在执行 ${name}，有结果我会继续告诉你。`)
  }

  private failureFeedback(conversation: PeerConversation, activity: ConversationActivity, report: DeliveryReport): void {
    if (report.status === 'accepted' || report.status === 'cancelled') return
    // 表情库里没有这张图是本地可判定的事实，正文已经按纯文字继续发出，不再额外告警。
    const unresolved = report.units.filter(unit => unit.status === 'failed' || unit.status === 'unknown')
    if (unresolved.length > 0 && unresolved.every(unit => unit.kind === 'sticker' && unit.error === '表情不存在或不可发送')) return
    const activityId = report.units[0]?.activityId ?? activity.id
    if (this.deliveryWarnings.has(activityId)) return
    this.deliveryWarnings.add(activityId)
    // 回答所属作用域可能已被补充消息作废；反馈是新的控制消息，走独立作用域。
    const text = report.status === 'partial'
      ? '这条回复只发出了一部分。发送「重试」可以补发未确认的内容。'
      : report.status === 'unknown'
        ? '回复已生成，但发送结果未确认。发送「重试」可以重新发送。'
        : '回复已生成，但没有发送成功。发送「重试」可以重新发送。'
    this.notice(conversation, text, undefined, true)
  }

  /** 只重投已保存的未确认内容；不重新运行模型或工具，使用最新入站令牌。 */
  private async retryDelivery(peerId: string): Promise<'idle' | 'retried' | 'failed'> {
    const conversation = await this.conversation(peerId)
    const history = await this.history.history(peerId)
    // 只考虑真正的内容单元：菜单、提示和反馈也走队列，但它们不是可重发的回答。
    const candidates = history.deliveries.filter(unit => unit.generation === conversation.generation
      && (unit.status === 'failed' || unit.status === 'unknown')
      && !unit.activityId.startsWith('control:'))
    if (!candidates.length) return 'idle'
    // 只补发最近一组未确认内容；已经接受的气泡不重复发送。
    // 组内后续单元可能因前一项失败被标成 cancelled，它们也属于“还没发出去”的内容。
    const latest = candidates.at(-1)!
    const group = history.deliveries.filter(unit => unit.groupId === latest.groupId
      && (unit.status === 'failed' || unit.status === 'unknown' || (unit.status === 'cancelled' && unit.error === '前一条未发出，已取消')))
      // 本地已判定不存在的表情不必再试；否则它会永远挡着同一组里的文字。
      .filter(unit => unit.error !== '表情不存在或不可发送')
    if (!group.length) return 'idle'
    const token = () => this.contextTokens.get(peerId) ?? latest.contextToken
    const attempt = `${String(Date.now())}`
    // 补发内容仍是“回答”，不能用 control 作用域，否则会被下次重试当成提示排除。
    const scope = { ...conversation.controlScope(), activityId: `retry:${attempt}` }
    this.deliveryWarnings.delete(latest.activityId)
    for (const [index, unit] of group.entries()) {
      const plan = { ...DEFAULT_REPLY_PLAN, splitMode: 'none' as const }
      const retryGroup = `${unit.groupId}:retry:${attempt}:${String(index)}`
      const report = unit.kind === 'file'
        ? await this.options.replies.enqueueFiles(peerId, [unit.value], token, scope, retryGroup)
        : await this.options.replies.enqueue(peerId, unit.kind === 'sticker' ? `[表情:${unit.value}]` : unit.value, token, plan, { scope, groupId: retryGroup })
      // 原记录一律收口：失败时由新的重试记录继续承担，避免下一次重试又挑中旧记录。
      await this.history.saveDelivery({ ...unit, status: 'cancelled', error: '已转由重试记录' })
      if (report.status !== 'accepted') return 'failed'
    }
    return 'retried'
  }

  /**
   * 干活期间每隔一段时间报一句平安。
   *
   * 句子来自人格卡（`noticesFor`），一轮内由 `createNoticePicker` 洗牌后依次取，不重复。
   * 只在「这一轮还在跑」时响；正文到达、回合结束、停止、关闭都会停。
   *
   * 同一轮里可能多次交给宿主（连续入站）：这时沿用已有的取句进度，只重排定时器。
   * 重建取句器会让已发过的句子重新进入池子，正是「连发之后开始重复」的成因。
   */
  private startNotices(conversation: PeerConversation, activity: ConversationActivity): void {
    const interval = this.options.noticeIntervalMs ?? DEFAULT_NOTICE_INTERVAL_MS
    if (interval <= 0) return
    const window = this.options.noticeWindowMs ?? DEFAULT_NOTICE_WINDOW_MS
    const now = (this.options.now ?? Date.now)()
    const existing = this.notices.get(conversation.peerId)
    if (existing !== undefined) clearTimeout(existing.timer)
    // 同一轮里再次交给宿主：沿用进度与已发条数，只把截止时间往后挪。
    const sameRound = existing !== undefined && existing.activityId === activity.id
    const next = sameRound ? existing.next : createNoticePicker(this.noticeLines.get(conversation.peerId) ?? [])
    const state = {
      timer: undefined as unknown as NodeJS.Timeout,
      activityId: activity.id,
      next,
      sent: sameRound ? existing.sent : 0,
      deadline: now + window,
    }
    // 上限由窗口推导：60 秒间隔、600 秒窗口 = 最多 10 条。
    // ⚠️ 与 `persona/card.ts` 的 MIN_PROGRESS_LINES 是同一对约束：人格卡至少要写够
    // 这么多条才能保证一轮内不重复。调大窗口（或调小间隔）会让配额超过 10，
    // 那时必须同步上调那个下限，否则一轮内会开始重样。
    const maxNotices = Math.max(1, Math.ceil(window / interval))
    const schedule = (): void => {
      const timer = setTimeout(() => {
        if (this.closed || conversation.activity !== activity || activity.signal.aborted) { this.stopNotices(conversation.peerId); return }
        if (activity.phase === 'idle' || activity.phase === 'compacting') { this.stopNotices(conversation.peerId); return }
        if ((this.options.now ?? Date.now)() >= state.deadline || state.sent >= maxNotices) {
          this.options.report?.('报平安结束', { peerId: conversation.peerId.slice(0, 12), activity: activity.id.slice(0, 8), sent: state.sent, max: maxNotices })
          this.stopNotices(conversation.peerId)
          return
        }
        const line = next()
        if (line !== undefined) {
          state.sent += 1
          this.options.report?.('报平安', { peerId: conversation.peerId.slice(0, 12), activity: activity.id.slice(0, 8), nth: state.sent, max: maxNotices, chars: line.length })
          this.notice(conversation, line, activity, false, 'low')
        }
        schedule()
      }, interval)
      timer.unref?.()
      state.timer = timer
      this.notices.set(conversation.peerId, state)
    }
    schedule()
  }

  private stopNotices(peerId: string): void {
    const entry = this.notices.get(peerId)
    if (entry !== undefined) clearTimeout(entry.timer)
    this.notices.delete(peerId)
  }
  private subscribeReplies(): void {
    if (this.unsubscribe || this.closed) return
    this.unsubscribe = this.options.events.on('session/event', (session, event) => {
      const route = this.routes.get(String(session.id))
      if (!route || !isRecord(event)) return
      const { conversation } = route
      if (route.generation !== conversation.generation) return
      const data = isRecord(event.data) ? event.data : {}
      const turn = typeof data.turn === 'number' ? data.turn : undefined
      if (event.type === 'turn/start' && turn !== undefined) {
        conversation.turnStart(turn, (this.options.now ?? Date.now)())
        // 开轮了：之前那段「排队等很久」的计时不再成立。
        this.disarmStallWatch(conversation.peerId)
        this.reportLeg(conversation.peerId, 'turn-start', conversation.activity!)
        return
      }
      if (event.type === 'user/message') { if (typeof data.id === 'string') conversation.messageClaimed(data.id); return }
      const activity = conversation.eventActivity(turn)
      if (!activity) return
      // 见到任何一步进展就认为这一轮在跑；漏掉 turn/start 也不至于一直当作「还在排队」。
      if (activity.phase === 'submitted') {
        conversation.markRunning((this.options.now ?? Date.now)())
        this.disarmStallWatch(conversation.peerId)
        this.reportLeg(conversation.peerId, 'turn-start', activity)
      }
      if (event.type === 'turn/end') { this.options.onSessionSettled?.(String(session.id)); this.onTurnEnd(conversation, event, turn); return }
      // 新补充还没被模型接走时，这一轮产出的正文回答的是「补充之前」的问题，先压住。
      // 待认领集合会在 turn/start 与 turn/end 清空，所以它不会永久把输出卡死。
      if (turn !== undefined && activity.pendingMessages.size > 0) return
      if (event.type === 'deliverables/presented') { this.present(conversation, activity, data, event); return }
      const progress = extractProgressText(event)
      if (progress !== undefined) this.progressNotice(conversation, activity, progress)
      const toolName = extractToolName(event)
      if (toolName !== undefined) this.toolProgress(conversation, activity, toolName)
      const text = extractAssistantText(event)
      if (text === undefined) return
      this.clearProgress(conversation.peerId)
      this.stopNotices(conversation.peerId)
      conversation.markFirstText((this.options.now ?? Date.now)())
      this.reportLeg(conversation.peerId, 'first-text', activity)
      const scope = conversation.scope(activity)
      const groupId = `${String(session.id)}:${isRecord(data.message) && typeof data.message.id === 'string' ? data.message.id : event.seq ?? `${activity.id}:${turn ?? ''}:${data.step ?? ''}:${createHash('sha256').update(text).digest('hex')}`}`
      this.track(this.eventQueue(conversation.peerId).run(async () => {
        const old = (await this.history.history(conversation.peerId)).deliveries
        if (old.some(unit => unit.groupId === groupId)) return
        if (scope?.signal?.aborted) return
        const classified = extractStickerAnnotations(text.replace(/\[记住[:：][^\]\n]*\]/gu, ''))
        await this.options.stickers?.annotate(conversation.peerId, classified.annotations)
        if (scope?.signal?.aborted) return
        // 长任务可能跑了几分钟；每次尝试都取这期间最新收到的令牌。
        const token = () => this.contextTokens.get(conversation.peerId) ?? activity.contextToken
        this.track(this.options.replies.enqueue(conversation.peerId, expandLocationTokens(classified.text), token, this.plans.get(conversation.peerId), { scope, groupId, priority: 'high' })
          .then(report => { this.reportDelivery(conversation.peerId, report); this.failureFeedback(conversation, activity, report) }))
      }))
    })
  }
  private present(conversation: PeerConversation, activity: ConversationActivity, data: Record<string, unknown>, event: Record<string, unknown>): void {
    const paths = Array.isArray(data.files) ? data.files.flatMap(file => isRecord(file) && typeof file.path === 'string' ? [isAbsolute(file.path) ? file.path : resolve(this.options.cwd ?? '.', file.path)] : []) : []
    if (!paths.length) return
    this.clearProgress(conversation.peerId)
    conversation.markFirstText((this.options.now ?? Date.now)())
    const scope = conversation.scope(activity)
    this.track(this.eventQueue(conversation.peerId).run(async () => {
      if (scope?.signal?.aborted) return
      const groupId = `${sessionIdFor(conversation.peerId, conversation.generation)}:files:${event.seq ?? `${activity.id}:${createHash('sha256').update(JSON.stringify(paths)).digest('hex')}`}`
      if ((await this.history.history(conversation.peerId)).deliveries.some(unit => unit.groupId === groupId)) return
      const token = () => this.contextTokens.get(conversation.peerId) ?? activity.contextToken
      this.track(this.options.replies.enqueueFiles(conversation.peerId, paths, token, scope, groupId, 'high')
        .then(report => { this.reportDelivery(conversation.peerId, report); if (report.status === 'failed' || report.status === 'unknown') this.notice(conversation, '文件未确认发出，可以让我重试。') }))
    }))
  }
  private reportDelivery(peerId: string, report: DeliveryReport): void {
    this.options.report?.(report.status === 'accepted' ? '回复已被微信服务端接受' : `回复投递结果：${report.status}`, { peerId })
  }
  private onTurnEnd(conversation: PeerConversation, event: Record<string, unknown>, turn?: number): void {
    const activity = conversation.finish(turn)
    if (!activity) return
    this.disarmStallWatch(conversation.peerId)
    this.stopNotices(conversation.peerId)
    this.reportLeg(conversation.peerId, 'turn-end', activity)
    this.clearProgress(conversation.peerId); this.options.approvals?.cancel(conversation.peerId)
    const data = isRecord(event.data) ? event.data : {}, reason = isRecord(data.reason) ? data.reason : {}
    switch (reason.kind) {
      case 'error': {
        const error = isRecord(reason.error) ? reason.error : {}
        const message = typeof error.message === 'string' ? error.message : ''
        const brief = message.length > 300 ? `${message.slice(0, 300)}…` : message
        this.notice(conversation, brief === '' ? '这一轮没完成，可以让我重试。' : `模型或服务暂时出错了：${brief}\n可以重试，或在「设置」里换模型。`, activity)
        break
      }
      case 'blocked': this.notice(conversation, '这段会话暂时无法继续，可以发“新对话”重新开始。', activity); break
      case 'max-tokens': this.notice(conversation, '回答达到长度上限，可以让我接着说。', activity); break
      case 'aborted': this.notice(conversation, '这一轮已中断。', activity); break
      case 'completed':
        // 正常结束却没有正文或文件：不能让用户对着一片空白等。
        if (activity.at.firstText === undefined) this.notice(conversation, '这一轮结束了，但没有生成可发送的回复。可以让我重试，或换个说法再问一次。', activity)
        break
    }
  }
  memoryActivity(peerId: string): MemoryActivity | undefined {
    for (const route of this.routes.values()) if (route.conversation.peerId === peerId && route.generation === route.conversation.generation) return route.conversation.activity
    return undefined
  }
  async context(peerId: string): Promise<string> { const conversation = await this.conversation(peerId); return await this.history.context(peerId, conversation.generation) }
  contextTokenFor(peerId: string): string | undefined { return this.contextTokens.get(peerId) }
  setApprovals(approvals: NonNullable<ChannelOptions['approvals']>): void { this.options.approvals = approvals }
  peerForSession(sessionId: string): string | undefined { const route = this.routes.get(sessionId); return route?.generation === route?.conversation.generation ? route?.conversation.peerId : undefined }
  knownPeers(): readonly string[] { return this.activity.peers() }
  getCursor(): string | undefined { return this.cursor }
  async whenIdle(): Promise<void> {
    for (const pending of this.conversations.values()) { const conversation = await pending; if (conversation.pending.length) this.track(this.flush(conversation)) }
    while (this.jobs.size) await Promise.allSettled([...this.jobs])
    await this.options.replies.whenIdle()
  }
  async stop(): Promise<void> {
    this.running = false; this.closed = true; this.abort?.abort(); this.unsubscribe?.(); this.unsubscribe = undefined
    for (const pending of this.conversations.values()) {
      const conversation = await pending
      conversation.close(); this.options.replies.cancel(conversation.peerId); this.clearProgress(conversation.peerId); this.stopNotices(conversation.peerId)
      this.options.approvals?.cancel(conversation.peerId)
    }
    this.controls.dispose()
    await this.options.sessions.disposeAll?.()
    await this.whenIdle(); await this.activity.flush?.()
  }
}
