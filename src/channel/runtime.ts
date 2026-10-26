/**
 * 通道运行时：长轮询 → 入站 → 会话 → 出站。
 *
 * 这一层只做接线，判断都在别处：谁能用（access）、怎么说（prompt）、怎么切（text）、
 * 怎么重试（reply）、会话怎么建（session）。
 *
 * @module wechat-persona/channel/runtime
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { asWeixinMessage, BusinessError, ERRCODE_SESSION_EXPIRED, type ApiClient } from '../ilink/api.ts'
import type { MessageItem, WeixinMessage } from '../ilink/types.ts'
import type { AccessPolicy } from '../bridge/access.ts'
import { composeInboundText } from '../bridge/prompt.ts'
import type { PreparedMedia } from '../bridge/media.ts'
import type { ReplyQueue } from '../bridge/reply.ts'
import { extractAssistantText } from '../bridge/reply.ts'
import { PeerSessions, sessionIdFor } from '../bridge/session.ts'
import { PersonaStore, type PersonaSnapshot } from '../persona/store.ts'
import { DEFAULT_CHAT_SETTINGS, type ChatSettings, type ChatSettingsStore } from '../persona/settings.ts'
import { proactiveInstruction, shouldPoke } from './proactive.ts'

/** 一个已登录账号。 */
export interface ChannelAccount {
  baseUrl: string
  token: string
  /** 扫码登录的微信号，用于默认白名单与「谁在驱动」的诊断。 */
  userId?: string | undefined
}

/** 会话事件的订阅面。 */
export interface SessionEventsLike {
  on(event: 'session/event', listener: (session: { id: unknown }, event: unknown) => void): () => void
}

export interface ChannelOptions {
  api: ApiClient
  account: ChannelAccount
  sessions: PeerSessions
  access: AccessPolicy
  personas: PersonaStore
  defaultPersona: string
  replies: ReplyQueue
  events: SessionEventsLike
  /** 诊断出口。 */
  report?: (line: string, detail?: unknown) => void
  /** 测试注入。 */
  sleep?: (ms: number) => Promise<void>
  /** 单次长轮询的服务端 hold 时长。 */
  pollTimeoutMs?: number
  /** 被限流后的退避上限。 */
  maxBackoffMs?: number
  /** 时钟，测试用。 */
  now?: () => number
  /** 时区，注入给 prompt。 */
  timeZone?: string
  /** 每个聊天的设置；缺失表示所有聊天都用默认设置。 */
  settings?: ChatSettingsStore
  /** 把消息里的媒体变成内容块；缺失表示这个宿主不支持媒体。 */
  prepareMedia?: (items: readonly MessageItem[]) => Promise<PreparedMedia>
}

const DEFAULT_POLL_TIMEOUT_MS = 35_000
const DEFAULT_MAX_BACKOFF_MS = 60_000
const MAX_SEEN_IDS = 2_000

/** 一条入站消息里我们能读到的文本（媒体在 M2 接）。 */
export function textOf(message: WeixinMessage): string {
  const parts: string[] = []
  for (const item of message.item_list ?? []) {
    if (item.type === 1 && typeof item.text_item?.text === 'string') parts.push(item.text_item.text)
    else if (item.type === 3 && typeof item.voice_item?.text === 'string' && item.voice_item.text !== '') {
      // 语音优先用服务端转写；没有转写就留一个占位，让模型知道有语音。
      parts.push(item.voice_item.text)
    }
  }
  return parts.join('\n').trim()
}

export class Channel {
  private readonly options: ChannelOptions
  private readonly sleep: (ms: number) => Promise<void>
  private cursor: string | undefined
  private running = false
  private abort: AbortController | undefined
  /** session id → peer id，用于把事件路由回微信。 */
  private readonly peerBySession = new Map<string, string>()
  /** peer → 最近一条入站消息的 context_token。 */
  private readonly contextTokens = new Map<string, string>()
  /** 已处理的 message_id，防重放。 */
  private readonly seen = new Set<string>()
  /** 已经有过历史、不该再注入完整人设的 peer。 */
  private readonly warmed = new Set<string>()
  private snapshot: PersonaSnapshot | undefined
  private unsubscribe: (() => void) | undefined

  constructor(options: ChannelOptions) {
    this.options = options
    this.sleep = options.sleep ?? (async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) })
  }

  /** 从指定游标开始跑；返回的 Promise 在 stop 后 settle。 */
  async run(initialCursor?: string): Promise<void> {
    this.cursor = initialCursor
    this.running = true
    this.abort = new AbortController()
    this.snapshot = await this.options.personas.snapshot()
    this.subscribeReplies()

    const pollTimeout = this.options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
    let backoff = 1_000

    while (this.running) {
      try {
        const result = await this.options.api.getUpdates({
          baseUrl: this.options.account.baseUrl,
          endpoint: 'ilink/bot/getupdates',
          label: 'getupdates',
          token: this.options.account.token,
          ...(this.cursor === undefined ? {} : { cursor: this.cursor }),
          timeoutMs: pollTimeout + 5_000,
          signal: this.abort.signal,
        })
        backoff = 1_000
        for (const raw of result.msgs) await this.handle(raw)
        if (result.get_updates_buf !== undefined) this.cursor = result.get_updates_buf
      } catch (error) {
        if (!this.running) break
        if (error instanceof BusinessError && error.code === ERRCODE_SESSION_EXPIRED) {
          this.options.report?.('微信会话已失效（errcode -14），需要在插件页重新扫码')
          // 不盲目重试：token 已经无效，重试只是刷日志。
          this.running = false
          break
        }
        // 长轮询超时/网络抖动是常态：退避后继续，不把它当致命错误。
        this.options.report?.('轮询失败，稍后重试', { error: String(error) })
        await this.sleep(backoff)
        backoff = Math.min(this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS, backoff * 2)
      }
    }

    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  /** 停止轮询并等当前一轮处理完。 */
  async stop(): Promise<void> {
    this.running = false
    this.abort?.abort()
    await this.options.replies.whenIdle()
  }

  /** 当前游标，供宿主持久化。 */
  getCursor(): string | undefined {
    return this.cursor
  }

  /** 把一条原始消息处理完（供测试直接调用）。 */
  async handle(raw: unknown): Promise<void> {
    // 直接调用 handle（例如测试或补投）时也要有回复订阅，否则回答会掉进空处。
    if (this.unsubscribe === undefined) this.subscribeReplies()
    const message = asWeixinMessage(raw)
    if (message === undefined) return
    // 只处理用户发的；Bot 自己的回声要丢掉，否则会自问自答。
    if (message.message_type !== undefined && message.message_type !== 1) return

    const peerId = message.from_user_id ?? ''
    if (peerId === '') return

    const messageId = message.message_id === undefined ? undefined : String(message.message_id)
    if (messageId !== undefined) {
      if (this.seen.has(messageId)) return
      this.seen.add(messageId)
      if (this.seen.size > MAX_SEEN_IDS) {
        // 简单的有界缓存：超过上限就丢掉最早的一批。
        const drop = [...this.seen].slice(0, MAX_SEEN_IDS / 2)
        for (const id of drop) this.seen.delete(id)
      }
    }

    if (!this.options.access.admits(peerId)) {
      // 不回复陌生人是刻意的：回一句「你是谁」等于告诉对方机器人活着。
      this.options.report?.('拒绝了一个不在名单里的 peer', { peerId })
      return
    }

    if (message.context_token !== undefined && message.context_token !== '') {
      this.contextTokens.set(peerId, message.context_token)
    }

    const sessionId = sessionIdFor(peerId)
    this.peerBySession.set(sessionId, peerId)

    const settings: ChatSettings = this.options.settings === undefined
      ? DEFAULT_CHAT_SETTINGS
      : await this.options.settings.get(peerId)
    if (!settings.enabled) {
      // 明确关掉的聊天不投递：用户说了不想让它在某个对话里说话。
      this.options.report?.('这个聊天已被关闭，消息不投递', { peerId })
      return
    }

    const snapshot = await this.ensureSnapshot()
    const card = PersonaStore.resolve(settings.personaId ?? this.options.defaultPersona, snapshot)
    const text = composeInboundText({
      card,
      peer: peerId,
      text: textOf(message),
      first: !this.warmed.has(peerId),
      ...(this.options.timeZone === undefined ? {} : { timeZone: this.options.timeZone }),
      ...(this.options.now === undefined ? {} : { now: new Date(this.options.now()) }),
    })

    // 先记「已经暖过」再投递：投递失败重来时不该再灌一遍完整设定。
    this.warmed.add(peerId)

    // 媒体：能附上就附，附不上就把说明拼进文字——丢图可以，丢消息不行。
    let prepared: PreparedMedia = { parts: [], notes: [] }
    if (this.options.prepareMedia !== undefined) {
      try {
        prepared = await this.options.prepareMedia(message.item_list ?? [])
      } catch (error) {
        this.options.report?.('媒体预处理失败', { error: String(error) })
      }
    }
    const notesText = prepared.notes.length === 0 ? '' : `\n${prepared.notes.join('\n')}`

    const userMessage = createUserMessage({
      content: [{ type: 'text', text: `${text}${notesText}` }, ...prepared.parts] as never,
      source: { kind: 'user' },
    })
    this.lastActivity.set(peerId, (this.options.now ?? Date.now)())
    if (settings.maxChars === undefined) this.chatMaxChars.delete(peerId)
    else this.chatMaxChars.set(peerId, settings.maxChars)
    await this.options.sessions.deliver(peerId, userMessage as never)
  }

  /** 人格快照：run 时加载一次；直接调 handle（测试/补投）时按需加载。 */
  private async ensureSnapshot(): Promise<PersonaSnapshot> {
    if (this.snapshot === undefined) this.snapshot = await this.options.personas.snapshot()
    return this.snapshot
  }

  /** 每个 peer 最后一次说话的时间，主动搭话用。 */
  private readonly lastActivity = new Map<string, number>()

  /** 读某个 peer 的最近活跃时间（毫秒）；没说过话返回 undefined。 */
  lastSeen(peerId: string): number | undefined {
    return this.lastActivity.get(peerId)
  }

  /** 已知的 peer 列表（说过话的）。 */
  knownPeers(): readonly string[] {
    return [...this.lastActivity.keys()]
  }

  /**
   * 让某个 peer 的模型主动说一句。
   *
   * 走的是正常的一轮：投一条「主动开口」的指令，回答由回复队列发出去。
   * 这样主动消息和普通回复共用同一条投递路径，不需要第二套发送逻辑。
   *
   * @param peerId - 目标用户。
   * @returns 是否真的发起了这一轮。
   */
  async poke(peerId: string): Promise<boolean> {
    const now = (this.options.now ?? Date.now)()
    const settings = this.options.settings === undefined ? DEFAULT_CHAT_SETTINGS : await this.options.settings.get(peerId)
    const snapshot = await this.ensureSnapshot()
    const card = PersonaStore.resolve(settings.personaId ?? this.options.defaultPersona, snapshot)

    const allowed = shouldPoke({
      now,
      lastSeenAt: this.lastActivity.get(peerId),
      minIdleHours: card.proactive.minIdleHours,
      quietHours: card.proactive.quietHours,
      enabled: settings.proactive && settings.enabled && card.proactive.enabled,
    })
    if (!allowed) return false

    const text = composeInboundText({ card, peer: peerId, text: proactiveInstruction(), first: false })
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    // 先记时间再投递：投递失败也不该在下一分钟后重复轰炸。
    this.lastActivity.set(peerId, now)
    await this.options.sessions.deliver(peerId, message as never)
    return true
  }

  /**
   * 起一个定时器，周期性检查所有聊过的 peer。
   * @param intervalMs - 检查间隔。
   * @returns 停止函数。
   */
  startProactive(intervalMs = 10 * 60_000): () => void {
    const timer = setInterval(() => {
      void (async () => {
        for (const peerId of this.knownPeers()) {
          try {
            await this.poke(peerId)
          } catch (error) {
            this.options.report?.('主动搭话失败', { peerId, error: String(error) })
          }
        }
      })()
    }, intervalMs)
    timer.unref()
    return () => { clearInterval(timer) }
  }

  /** 这个聊天的长度上限；读设置，读不到就用 undefined（队列默认值）。 */
  private maxCharsFor(peerId: string): number | undefined {
    // 同步路径上不阻塞：设置已在入站时读过并缓存进 store。
    return this.chatMaxChars.get(peerId)
  }

  /** 入站时记下的每聊天长度上限。 */
  private readonly chatMaxChars = new Map<string, number>()

  private subscribeReplies(): void {
    this.unsubscribe = this.options.events.on('session/event', (session, event) => {
      const text = extractAssistantText(event)
      if (text === undefined) return
      const peerId = this.peerBySession.get(String(session.id))
      if (peerId === undefined) return
      void this.options.replies.enqueue(peerId, text, this.contextTokens.get(peerId), this.maxCharsFor(peerId))
    })
  }
}
