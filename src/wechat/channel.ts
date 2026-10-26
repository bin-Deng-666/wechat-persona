/** WeChat ingress and DSH event routing. Each contact owns its conversation lifecycle. */
import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import { asWeixinMessage, BusinessError, ERRCODE_SESSION_EXPIRED, type ApiClient } from '../ilink/api.ts'
import type { MessageItem, WeixinMessage } from '../ilink/types.ts'
import type { AccessPolicy } from './access.ts'
import type { ActivityStore } from '../chat/activity.ts'
import { ConversationStore, type InboundRecord, type AgentBatch } from '../chat/history.ts'
import { PeerConversation, type ConversationActivity } from '../chat/conversation.ts'
import { DEFAULT_REPLY_PLAN, resolvePlan, type ReplyPlan } from '../reply/bubbles.ts'
import { expandLocationTokens } from '../text/location.ts'
import { ChatControls } from './controls.ts'
import type { PreparedMedia } from '../dsh/attachments.ts'
import type { CompactOutcome } from '../dsh/compaction.ts'
import type { ReplyQueue, DeliveryReport } from '../reply/queue.ts'
import { extractAssistantText } from '../dsh/events.ts'
import { PeerSessions, sessionIdFor } from '../dsh/sessions.ts'
import { PersonaStore } from '../persona/store.ts'
import { DEFAULT_CHAT_SETTINGS, type ChatSettings, type ChatSettingsStore } from '../chat/settings.ts'
import { extractStickerAnnotations } from '../stickers/markers.ts'
import type { StickerLibrary } from '../stickers/library.ts'
import { parseCommand } from './commands.ts'
import type { PeerGenerations } from '../chat/generations.ts'
import { SerialWork } from '../storage/atomic.ts'
import type { PeerMemory } from '../memory/store.ts'
import type { MemoryActivity } from '../memory/capture.ts'

export interface ChannelAccount { baseUrl: string; token: string; userId?: string }
export interface SessionEventsLike { on(event: 'session/event', listener: (session: { id: unknown }, event: unknown) => void): () => void }
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
  generations?: PeerGenerations
  compact?: (peerId: string, generation: number, signal?: AbortSignal) => Promise<CompactOutcome>
  permissionLabel?: string
  typing?: { start: (peerId: string, contextToken?: string) => Promise<unknown>; stop: (peerId: string) => Promise<unknown> }
  approvals?: { answer: (peerId: string, text: string) => boolean; cancel: (peerId: string, why?: string) => void }
  cwd?: string
  sendSticker?: (peerId: string, name: string, contextToken: string | undefined) => Promise<boolean>
  prepareMedia?: (items: readonly MessageItem[], peerId?: string, signal?: AbortSignal) => Promise<PreparedMedia>
  activity?: ActivityStore
  memory?: PeerMemory
  modelLabel?: string
  stickers?: Pick<StickerLibrary, 'names' | 'annotate' | 'adoptLatest'>
  mergeWindowMs?: number
  progressAfterMs?: number
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
  private readonly progress = new Map<string, NodeJS.Timeout>()
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
      planFor: peer => this.plans.get(peer), setPlan: (peer, plan) => { this.plans.set(peer, plan) },
      contextTokenFor: peer => this.contextTokens.get(peer), lastSeen: peer => this.activity.get(peer),
      turnsFor: peer => this.turnCounts.get(peer) ?? 0,
      cancelTurn: async peer => await this.stopConversation(await this.conversation(peer)),
      newConversation: async peer => await this.newConversation(await this.conversation(peer)),
      compactConversation: async peer => await this.compactConversation(await this.conversation(peer)),
      sendSticker: async (peer, name, token) => (await options.replies.enqueue(peer, `[表情:${name}]`, token, undefined, { immediate: true })).status === 'accepted',
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
    const message = asWeixinMessage(raw)
    if (!message || (message.message_type !== undefined && message.message_type !== 1)) return
    const peerId = message.from_user_id ?? ''
    if (!peerId || !this.options.access.admits(peerId)) return
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
    const token = record.raw.context_token
    if (token) this.contextTokens.set(peerId, token)
    void this.options.typing?.start(peerId, token)
    if (this.options.approvals?.answer(peerId, record.text)) { await this.history.inputStatus(peerId, [record.id], 'control'); return }
    const command = parseCommand(record.text)
    if (command) {
      await this.history.inputStatus(peerId, [record.id], 'control')
      const execute = async () => {
        try {
          if (await this.controls.consumeMenu(peerId, record.text)) return
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
    // Menu lookup can send a card, so it runs off the ingress loop as well.
    if (await this.controls.consumeMenu(peerId, record.text)) { await this.history.inputStatus(peerId, [record.id], 'control'); return }
    if (!(await this.settingsFor(peerId)).enabled) { await this.history.inputStatus(peerId, [record.id], 'cancelled'); return }
    if (conversation.activity?.phase === 'compacting') conversation.invalidate()
    conversation.pending.push(record)
    if (conversation.activity?.phase === 'running') {
      conversation.activity.pendingMessages.add(`input:${record.id}`)
      conversation.activity.output.abort()
    }
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
      const activity = conversation.begin(records)
      const settings = await this.settingsFor(conversation.peerId)
      const card = PersonaStore.resolve(settings.personaId ?? this.options.defaultPersona, await this.options.personas.snapshot())
      this.plans.set(conversation.peerId, resolvePlan(card, settings))
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
    this.startProgress(conversation, activity)
    const message = freezeMessage({ id: batch.id, role: 'user', content: batch.content, source: { kind: 'user' } } as never)
    await this.options.sessions.deliver(peerId, message as never, conversation.generation)
    batch.status = 'submitted'; await this.history.saveBatch(peerId, batch)
    this.activity.touch(peerId, (this.options.now ?? Date.now)())
    this.turnCounts.set(peerId, (this.turnCounts.get(peerId) ?? 0) + 1)
  }
  private async recoverInputs(): Promise<void> {
    for (const peerId of await this.history.peers()) {
      if (!this.options.access.admits(peerId)) continue
      const conversation = await this.conversation(peerId)
      const state = await this.history.history(peerId)
      for (const batch of state.batches.filter(batch => batch.status !== 'cancelled' && batch.generation === conversation.generation)) {
        if (batch.status !== 'pending') continue
        const records = state.inputs.filter(input => batch.inputIds.includes(input.id))
        const activity = conversation.begin(records)
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
    this.controls.closeMenu(conversation.peerId)
    await this.history.cancelTask(conversation.peerId, conversation.generation)
    this.options.approvals?.cancel(conversation.peerId, '用户停止')
    const cancelled = await this.options.sessions.cancel?.(conversation.peerId, conversation.generation) ?? false
    if (pending.length) await this.history.inputStatus(conversation.peerId, pending.map(record => record.id), 'cancelled')
    const state = await this.history.history(conversation.peerId)
    for (const batch of state.batches.filter(batch => batch.generation === conversation.generation && batch.status === 'pending')) await this.history.saveBatch(conversation.peerId, { ...batch, status: 'cancelled' })
    await this.history.notice(conversation.peerId, '用户停止了当前任务和未发送内容')
    return active || output || cancelled || pending.length > 0
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
    const activity = conversation.begin([]); activity.phase = 'compacting'
    try { return await this.options.compact(conversation.peerId, conversation.generation, activity.signal) }
    finally { if (!activity.signal.aborted) activity.phase = 'idle' }
  }
  private notice(conversation: PeerConversation, text: string, activity?: ConversationActivity): void {
    const plan = this.plans.get(conversation.peerId) ?? DEFAULT_REPLY_PLAN
    const scope = activity ? conversation.scope(activity) : conversation.controlScope()
    const token = activity?.contextToken ?? this.contextTokens.get(conversation.peerId)
    this.track(this.eventQueue(conversation.peerId).run(async () => {
      if (scope?.signal?.aborted) return
      this.track(this.options.replies.enqueue(conversation.peerId, text, token, { ...plan, splitMode: 'none' }, { immediate: true, scope }))
    }))
  }
  private startProgress(conversation: PeerConversation, activity: ConversationActivity): void {
    this.clearProgress(conversation.peerId)
    const delay = this.options.progressAfterMs ?? 25000
    if (delay <= 0) return
    const timer = setTimeout(() => {
      this.progress.delete(conversation.peerId)
      if (conversation.activity === activity && activity.phase === 'running' && !activity.signal.aborted) this.notice(conversation, '还在处理，稍等一下。', activity)
    }, delay)
    timer.unref?.(); this.progress.set(conversation.peerId, timer)
  }
  private clearProgress(peerId: string): void { const timer = this.progress.get(peerId); if (timer) clearTimeout(timer); this.progress.delete(peerId) }
  private subscribeReplies(): void {
    if (this.unsubscribe || this.closed) return
    this.unsubscribe = this.options.events.on('session/event', (session, event) => {
      const route = this.routes.get(String(session.id))
      if (!route || !isRecord(event)) return
      const { conversation } = route
      if (route.generation !== conversation.generation) return
      const data = isRecord(event.data) ? event.data : {}
      const turn = typeof data.turn === 'number' ? data.turn : undefined
      if (event.type === 'turn/start' && turn !== undefined) { conversation.turnStart(turn); return }
      if (event.type === 'user/message') { if (typeof data.id === 'string') conversation.messageClaimed(data.id); return }
      const activity = conversation.eventActivity(turn)
      if (!activity) return
      if (event.type === 'turn/end') { this.onTurnEnd(conversation, event, turn); return }
      // A response generated before fresh steering was consumed cannot answer that steering.
      if (turn !== undefined && activity.pendingMessages.size > 0) return
      if (event.type === 'deliverables/presented') { this.present(conversation, activity, data, event); return }
      const text = extractAssistantText(event)
      if (text === undefined) return
      this.clearProgress(conversation.peerId)
      const scope = conversation.scope(activity)
      const token = activity.contextToken
      const groupId = `${String(session.id)}:${isRecord(data.message) && typeof data.message.id === 'string' ? data.message.id : event.seq ?? `${activity.id}:${turn ?? ''}:${data.step ?? ''}:${createHash('sha256').update(text).digest('hex')}`}`
      this.track(this.eventQueue(conversation.peerId).run(async () => {
        const old = (await this.history.history(conversation.peerId)).deliveries
        if (old.some(unit => unit.groupId === groupId)) return
        if (scope?.signal?.aborted) return
        const classified = extractStickerAnnotations(text.replace(/\[记住[:：][^\]\n]*\]/gu, ''))
        await this.options.stickers?.annotate(conversation.peerId, classified.annotations)
        if (scope?.signal?.aborted) return
        this.track(this.options.replies.enqueue(conversation.peerId, expandLocationTokens(classified.text), token, this.plans.get(conversation.peerId), { scope, groupId })
          .then(report => { this.reportDelivery(conversation.peerId, report) }))
      }))
    })
  }
  private present(conversation: PeerConversation, activity: ConversationActivity, data: Record<string, unknown>, event: Record<string, unknown>): void {
    const paths = Array.isArray(data.files) ? data.files.flatMap(file => isRecord(file) && typeof file.path === 'string' ? [isAbsolute(file.path) ? file.path : resolve(this.options.cwd ?? '.', file.path)] : []) : []
    if (!paths.length) return
    this.clearProgress(conversation.peerId)
    const token = activity.contextToken, scope = conversation.scope(activity)
    this.track(this.eventQueue(conversation.peerId).run(async () => {
      if (scope?.signal?.aborted) return
      const groupId = `${sessionIdFor(conversation.peerId, conversation.generation)}:files:${event.seq ?? `${activity.id}:${createHash('sha256').update(JSON.stringify(paths)).digest('hex')}`}`
      if ((await this.history.history(conversation.peerId)).deliveries.some(unit => unit.groupId === groupId)) return
      this.track(this.options.replies.enqueueFiles(conversation.peerId, paths, token, scope, groupId)
        .then(report => { this.reportDelivery(conversation.peerId, report); if (report.status === 'failed' || report.status === 'unknown') this.notice(conversation, '文件未确认发出，可以让我重试。', activity) }))
    }))
  }
  private reportDelivery(peerId: string, report: DeliveryReport): void {
    this.options.report?.(report.status === 'accepted' ? '回复已被微信服务端接受' : `回复投递结果：${report.status}`, { peerId })
  }
  private onTurnEnd(conversation: PeerConversation, event: Record<string, unknown>, turn?: number): void {
    const activity = conversation.finish(turn)
    if (!activity) return
    if (turn !== undefined && activity.pendingMessages.size) return
    this.clearProgress(conversation.peerId); this.options.approvals?.cancel(conversation.peerId)
    const data = isRecord(event.data) ? event.data : {}, reason = isRecord(data.reason) ? data.reason : {}
    switch (reason.kind) {
      case 'error': this.notice(conversation, '这一轮没完成，消息和已完成的步骤仍然保留。可以让我重试。', activity); break
      case 'blocked': this.notice(conversation, '这段会话暂时无法继续，可以发“新对话”重新开始。', activity); break
      case 'max-tokens': this.notice(conversation, '回答达到长度上限，可以让我接着说。', activity); break
      case 'aborted': this.notice(conversation, '这一轮已中断。', activity); break
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
      conversation.close(); this.options.replies.cancel(conversation.peerId); this.clearProgress(conversation.peerId)
      this.options.approvals?.cancel(conversation.peerId)
    }
    this.controls.dispose()
    await this.options.sessions.disposeAll?.()
    await this.whenIdle(); await this.activity.flush?.()
  }
}
