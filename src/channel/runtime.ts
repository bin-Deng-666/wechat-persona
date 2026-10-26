/**
 * 通道运行时：长轮询 → 入站 → 会话 → 出站。
 *
 * 这一层只做接线，判断都在别处：谁能用（access）、怎么说（prompt）、怎么切（text）、
 * 怎么重试（reply）、会话怎么建（session）。
 *
 * @module wechat-persona/channel/runtime
 */

import { isAbsolute, resolve } from 'node:path'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { asWeixinMessage, BusinessError, ERRCODE_SESSION_EXPIRED, type ApiClient } from '../ilink/api.ts'
import type { MessageItem, WeixinMessage } from '../ilink/types.ts'
import type { AccessPolicy } from '../bridge/access.ts'
import type { ActivityStore } from '../bridge/activity.ts'
import { DEFAULT_REPLY_PLAN, resolvePlan, type ReplyPlan } from '../bridge/bubbles.ts'
import { extractMemoryMarkers, type PeerMemory } from '../bridge/memory.ts'
import { expandLocationTokens } from '../bridge/text.ts'
import { MENU_TTL_MS, parseChoice, renderMenu, resolveChoice, type MenuPanel, type MenuView } from './menu.ts'
import { composeInboundText } from '../bridge/prompt.ts'
import type { PreparedMedia } from '../bridge/media.ts'
import type { ReplyQueue } from '../bridge/reply.ts'
import { extractAssistantText } from '../bridge/reply.ts'
import { PeerSessions, sessionIdFor } from '../bridge/session.ts'
import { PersonaStore, type PersonaSnapshot } from '../persona/store.ts'
import { DEFAULT_CHAT_SETTINGS, type ChatSettings, type ChatSettingsStore } from '../persona/settings.ts'
import { proactiveInstruction, shouldPoke } from './proactive.ts'
import { parseStickerToken } from '../persona/stickers.ts'
import { normalizeStickerName } from '../persona/sticker-inbox.ts'
import { formatAgo, formatHelp, formatNewChat, formatPersona, formatStatus, formatStyle, formatUnknown, parseCommand } from './commands.ts'
import type { PeerGenerations } from '../bridge/generations.ts'

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
  /** 会话失效（errcode -14）时回调：宿主据此清掉登录态。 */
  onSessionExpired?: () => void
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
  /** 每个聊天的对话代次（/new 用）；缺失表示不支持开新对话。 */
  generations?: PeerGenerations
  /** 当前权限档位，仅用于 /status 展示。 */
  permissionLabel?: string
  /** 输入状态上报；缺失表示不上报（headless 也能跑）。 */
  typing?: { start: (peerId: string, contextToken?: string) => Promise<unknown>; stop: (peerId: string) => Promise<unknown> }
  /** 微信里的审批：入站文本先问它是不是答复；缺失表示这个部署不转发审批。 */
  approvals?: {
    answer: (peerId: string, text: string) => boolean
    cancel: (peerId: string, why?: string) => void
  }
  /** 把会话「交付」的文件发到微信；缺失表示这个部署不支持发文件。 */
  sendFiles?: (peerId: string, paths: readonly string[], contextToken: string | undefined) => Promise<void>
  /** 会话的工作目录，用来把相对路径补全。 */
  cwd?: string
  /** 发一张本地表情；返回是否发出。缺失表示这个部署没有表情库。 */
  sendSticker?: (peerId: string, name: string, contextToken: string | undefined) => Promise<boolean>
  /** 把消息里的媒体变成内容块；缺失表示这个宿主不支持媒体。 */
  prepareMedia?: (items: readonly MessageItem[], peerId?: string) => Promise<PreparedMedia>
  /** 每个 peer 的最后活跃时间；缺省只存内存（重启后主动搭话会失效）。 */
  activity?: ActivityStore
  /** 跨会话记忆；缺省表示不支持「记住」。 */
  memory?: PeerMemory
  /** 当前模型 id，只用于设置卡片展示。 */
  modelLabel?: string
  /** 收表情：把最近一张入站图片收进表情库。 */
  stickerInbox?: {
    adopt: (peerId: string, name: string) => Promise<string | undefined>
    latest: (peerId: string) => Promise<string | undefined>
  }
  /** 本地表情库里的名字，注入第一轮人设；缺省表示没有表情库。 */
  stickerNames?: () => Promise<readonly string[]>
  /** 连发几条消息的合并窗口，毫秒；0 表示每条都单独成轮。 */
  mergeWindowMs?: number
  /** 一轮跑多久之后先回一句「还在弄」，毫秒；0 表示不提示。 */
  progressAfterMs?: number
}

/**
 * 单次长轮询的客户端上限。
 *
 * 服务端会把空闲请求握住十几秒（实测约 18s），**而且新消息不会唤醒已经握住的请求**——
 * 只会在下一次请求开始时交出来。于是「你发完等多久」完全取决于撞上当前 hold 的剩余时间。
 * 主动在 4 秒时切断重问，把最坏等待从 18 秒压到 4 秒出头；代价是请求数变多，
 * 但空闲时的空请求本来就只是心跳。
 */
const DEFAULT_POLL_TIMEOUT_MS = 4_000
const DEFAULT_MAX_BACKOFF_MS = 60_000
const MAX_SEEN_IDS = 2_000
/** 连发消息的合并窗口：微信用户习惯把一句话拆成几条发，逐条回会变成审问。 */
const DEFAULT_MERGE_WINDOW_MS = 400
/** 长任务第一句反馈的时机；再晚用户已经开始怀疑它死了。 */
const DEFAULT_PROGRESS_AFTER_MS = 25_000

/** 还在合并窗口里攒着的一条入站消息。 */
interface PendingInbound {
  texts: string[]
  items: MessageItem[]
  contextToken: string | undefined
  generation: number
  timer: NodeJS.Timeout | undefined
}

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
  /** 单次长轮询的客户端超时；跟着服务端建议值走。 */
  private pollTimeout: number | undefined
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
  /** 正在合并窗口里攒消息的 peer。 */
  private readonly pending = new Map<string, PendingInbound>()
  /** peer → 这个聊天的发送形态（人格卡 + 聊天设置算出来的）。 */
  private readonly plans = new Map<string, ReplyPlan>()
  /** peer → 正在展示的设置卡片。 */
  private readonly menus = new Map<string, { panel: MenuPanel; at: number }>()
  /** peer → 「还在弄」提示的定时器。 */
  private readonly progress = new Map<string, NodeJS.Timeout>()
  /** 已经投递、还没等到 turn/end 的 peer。 */
  private readonly turnActive = new Set<string>()
  /** 每个 peer 的最后活跃时间；落盘实现由宿主注入。 */
  private readonly activity: ActivityStore
  private snapshot: PersonaSnapshot | undefined
  private unsubscribe: (() => void) | undefined

  constructor(options: ChannelOptions) {
    this.options = options
    this.sleep = options.sleep ?? (async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) })
    // 没有落盘实现时退化成一个私有 Map：行为和以前一致，只是重启会丢。
    const memory = new Map<string, number>()
    this.activity = options.activity ?? {
      get: peerId => memory.get(peerId),
      touch: (peerId, at) => { memory.set(peerId, at) },
      peers: () => [...memory.keys()],
    }
  }

  /** 从指定游标开始跑；返回的 Promise 在 stop 后 settle。 */
  async run(initialCursor?: string): Promise<void> {
    this.cursor = initialCursor
    this.running = true
    this.abort = new AbortController()
    this.snapshot = await this.options.personas.snapshot()
    // 先恢复「谁安静了多久」：否则重启后主动搭话要到用户先说话才会重新开始计时。
    await this.activity.load?.()
    this.subscribeReplies()

    const pollTimeout = this.options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
    this.pollTimeout = pollTimeout
    let backoff = 1_000

    while (this.running) {
      const startedAt = (this.options.now ?? Date.now)()
      try {
        const result = await this.options.api.getUpdates({
          baseUrl: this.options.account.baseUrl,
          endpoint: 'ilink/bot/getupdates',
          label: 'getupdates',
          token: this.options.account.token,
          ...(this.cursor === undefined ? {} : { cursor: this.cursor }),
          timeoutMs: this.pollTimeout ?? pollTimeout,
          signal: this.abort.signal,
        })
        backoff = 1_000
        const waited = (this.options.now ?? Date.now)() - startedAt
        if (result.msgs.length > 0) {
          // 这条日志是判断「慢在哪」的关键：长轮询等了多久才把消息交给我们。
          this.options.report?.(`收到 ${String(result.msgs.length)} 条消息（长轮询等待 ${String(waited)}ms）`)
        }
        for (const raw of result.msgs) await this.handle(raw)
        if (result.get_updates_buf !== undefined) this.cursor = result.get_updates_buf

        // 服务端建议的 hold 只用来「往小里收」：它越大，我们越要勤问。
        if (result.longpolling_timeout_ms !== undefined && result.longpolling_timeout_ms > 0) {
          this.pollTimeout = Math.min(this.pollTimeout, result.longpolling_timeout_ms)
        }

        // 服务端本该 hold 住请求；如果它秒回且没有消息，这里补一小段睡眠，
        // 否则就是空转——一秒钟打几十次接口，看起来像被限流，其实是自己在刷。
        if (result.msgs.length === 0 && waited < 500) await this.sleep(500 - waited)
      } catch (error) {
        if (!this.running) break
        // 主动切断的空转不是故障：这是我们自己在缩短 hold，直接开下一次。
        if (isTimeout(error)) continue
        if (error instanceof BusinessError && error.code === ERRCODE_SESSION_EXPIRED) {
          this.options.report?.('微信会话已失效（errcode -14），需要在插件页重新扫码')
          this.options.onSessionExpired?.()
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
    // 让手机那头看到「对方正在输入」。失败无所谓，所以不 await。
    void this.options.typing?.start(peerId, message.context_token)

    const generation = this.options.generations === undefined ? 0 : await this.options.generations.get(peerId)

    const rawText = textOf(message)
    // 审批答复优先于一切：此刻模型正停在这一步等一个结论，
    // 把「1」当成普通消息喂进去，等于让它自己批自己。
    if (this.options.approvals?.answer(peerId, rawText) === true) return

    // 设置卡片打开时，单个数字就是一次点击。
    if (await this.menuAnswer(peerId, rawText)) return

    // 命令先于一切：/help 不该进模型，/new 更不能作为一条消息喂给旧会话。
    const command = parseCommand(rawText)
    if (command !== undefined) {
      // 但命令也不能插队到已经攒着的消息前面：先把它之前的话投出去。
      await this.flush(peerId)
      await this.runCommand(peerId, command, generation, message.context_token)
      return
    }

    const settings = await this.settingsFor(peerId)
    if (!settings.enabled) {
      // 明确关掉的聊天不投递：用户说了不想让它在某个对话里说话。
      this.options.report?.('这个聊天已被关闭，消息不投递', { peerId })
      return
    }

    const immediate = this.buffer(peerId, rawText, message.item_list ?? [], message.context_token, generation)
    // 窗口为 0（测试或「每条都单独成轮」的部署）时同步投递，别把 Promise 丢掉。
    if (immediate !== undefined) await immediate
  }
  // ---------------------------------------------------------------- 设置卡片

  /** 打开设置卡片（`/menu`）。 */
  async openMenu(peerId: string, panel: MenuPanel = 'root', contextToken?: string): Promise<void> {
    this.menus.set(peerId, { panel, at: (this.options.now ?? Date.now)() })
    const view = await this.menuView(peerId)
    await this.answer(peerId, renderMenu(panel, view), contextToken)
  }

  /**
   * 把一条消息当作卡片点击。
   *
   * @returns 被消费掉就 true；不是点击（或卡片过期）时 false，消息照常处理。
   */
  private async menuAnswer(peerId: string, text: string): Promise<boolean> {
    const state = this.menus.get(peerId)
    if (state === undefined) return false
    const now = (this.options.now ?? Date.now)()
    if (now - state.at > MENU_TTL_MS) {
      this.menus.delete(peerId)
      return false
    }
    const choice = parseChoice(text)
    if (choice === undefined) {
      // 用户开始说别的事：收起卡片，别把这句话吞掉。
      this.menus.delete(peerId)
      return false
    }
    this.menus.delete(peerId)
    await this.applyChoice(peerId, state.panel, choice, this.contextTokens.get(peerId))
    return true
  }

  private async applyChoice(peerId: string, panel: MenuPanel, choice: number, contextToken: string | undefined): Promise<void> {
    const resolved = resolveChoice(panel, choice)
    if (resolved.kind === 'close') {
      await this.answer(peerId, '好，设置先收起来。发 /menu 再打开。', contextToken)
      return
    }
    if (resolved.kind === 'panel') {
      await this.openMenu(peerId, resolved.panel, contextToken)
      return
    }
    if (resolved.kind === 'unknown') {
      await this.openMenu(peerId, panel, contextToken)
      return
    }

    const settings = this.options.settings
    const snapshot = await this.ensureSnapshot()
    const current = await this.settingsFor(peerId)
    const card = PersonaStore.resolve(current.personaId ?? this.options.defaultPersona, snapshot)

    switch (resolved.action) {
      case 'toggle-proactive': {
        if (settings === undefined) break
        const next = { ...current, proactive: !current.proactive }
        await settings.save(peerId, next)
        if (next.proactive && !card.proactive.enabled) {
          await this.answer(peerId, `这个聊天打开了主动，但人格卡「${card.name}」的 proactive.enabled 还是 false，所以仍然不会开口。`, contextToken)
        }
        break
      }
      case 'new-chat': {
        if (this.options.generations === undefined) {
          await this.answer(peerId, '这个部署没有开启多段对话。', contextToken)
          return
        }
        await this.options.generations.bump(peerId)
        this.warmed.delete(peerId)
        break
      }
      case 'sticker-library': {
        // 只是展示：表情的发送仍由模型在回复里写 [表情:名字] 决定。
        const names = this.options.stickerNames === undefined ? [] : await this.options.stickerNames()
        await this.answer(peerId, names.length === 0 ? '表情库是空的：把图片放进 stickers/ 目录就能用。' : `表情库（${String(names.length)} 张）：\n${names.join('、')}`, contextToken)
        return
      }
      case 'clear-memory': {
        await this.options.memory?.clear(peerId)
        await this.answer(peerId, '记忆清空了。', contextToken)
        break
      }
      case 'split-sentence':
      case 'split-paragraph':
      case 'split-none': {
        if (settings === undefined) break
        const split: ChatSettings['split'] =
          resolved.action === 'split-sentence' ? 'sentence' : resolved.action === 'split-paragraph' ? 'paragraph' : 'none'
        const next = { ...current, split }
        await settings.save(peerId, next)
        this.plans.set(peerId, resolvePlan(card, next))
        break
      }
      case 'max-chars-200': {
        if (settings === undefined) break
        const next = { ...current, maxChars: 200 }
        await settings.save(peerId, next)
        this.plans.set(peerId, resolvePlan(card, next))
        break
      }
      case 'style-reset': {
        if (settings === undefined) break
        const next = { ...current, maxChars: undefined, split: undefined }
        await settings.save(peerId, next)
        this.plans.set(peerId, resolvePlan(card, next))
        break
      }
      case 'model-default': {
        // 目前只能跟随桌面端：DSH 没有给插件「换某个会话的模型」的口子。
        await this.answer(peerId, '模型跟随桌面端的默认选择，聊天里暂时改不了。', contextToken)
        return
      }
      default: {
        const match = /^persona-(\d+)$/u.exec(resolved.action)
        if (match !== null && settings !== undefined) {
          const index = Number(match[1]) - 1
          const picked = [...snapshot.personas.values()][index]
          if (picked !== undefined) {
            await settings.save(peerId, { ...current, personaId: picked.card.id })
            this.warmed.delete(peerId)
          }
        }
      }
    }
    await this.openMenu(peerId, 'root', contextToken)
  }

  /** 组装卡片展示所需的当前状态。 */
  private async menuView(peerId: string): Promise<MenuView> {
    const snapshot = await this.ensureSnapshot()
    const settings = await this.settingsFor(peerId)
    const card = PersonaStore.resolve(settings.personaId ?? this.options.defaultPersona, snapshot)
    const plan = resolvePlan(card, settings)
    const names = this.options.stickerNames === undefined ? [] : await this.options.stickerNames()
    return {
      personaId: card.id,
      personaName: card.name,
      personaChoices: [...snapshot.personas.values()].map(persona => ({ id: persona.card.id, name: persona.card.name })),
      model: this.options.modelLabel ?? '',
      memoryCount: this.options.memory?.get(peerId).length ?? 0,
      memoryFacts: this.options.memory?.get(peerId) ?? [],
      proactive: settings.proactive,
      maxChars: plan.softChars,
      split: plan.splitMode,
      overridden: settings.maxChars !== undefined || settings.split !== undefined,
      canSwitchModel: false,
      stickerCount: names.length,
    }
  }

  /** 一条纯文本回复（走正常队列，限流/分条都复用）。 */
  private async answer(peerId: string, text: string, contextToken: string | undefined): Promise<void> {
    const plan = this.plans.get(peerId) ?? DEFAULT_REPLY_PLAN
    const started = (this.options.now ?? Date.now)()
    await this.options.replies.enqueue(peerId, text, contextToken, { ...plan, splitMode: 'none' }, { immediate: true })
    this.options.report?.(`卡片已发出（${String((this.options.now ?? Date.now)() - started)}ms）`)
  }

  /** 读这个聊天的设置；没有设置仓库时用默认值。 */
  private async settingsFor(peerId: string): Promise<ChatSettings> {
    return this.options.settings === undefined ? DEFAULT_CHAT_SETTINGS : await this.options.settings.get(peerId)
  }

  /**
   * 把一条消息放进合并窗口。
   *
   * 微信用户习惯把一句话拆成三四条发（「在吗」「问你个事」「帮我看看」）。
   * 每条都开一轮的话，会收到三个回答，而且后两个是在回答上一句的残片。
   */
  private buffer(peerId: string, text: string, items: readonly MessageItem[], contextToken: string | undefined, generation: number): Promise<void> | undefined {
    const existing = this.pending.get(peerId)
    const entry: PendingInbound = existing ?? {
      texts: [],
      items: [],
      contextToken: undefined,
      generation,
      timer: undefined,
    }
    entry.texts.push(text)
    entry.items.push(...items)
    if (contextToken !== undefined) entry.contextToken = contextToken
    entry.generation = generation

    if (entry.timer !== undefined) clearTimeout(entry.timer)
    const window = this.options.mergeWindowMs ?? DEFAULT_MERGE_WINDOW_MS
    if (window <= 0) {
      this.pending.set(peerId, entry)
      return this.flush(peerId)
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      void this.flush(peerId)
    }, window)
    entry.timer.unref?.()
    this.pending.set(peerId, entry)
    return undefined
  }

  /**
   * 把攒着的消息合成一轮投给模型。
   *
   * 出错要说话：会话建不起来（宿主在重启、preset 掉了）时用户只会看到「对方正在输入」消失，
   * 那种沉默会被理解成「它不理我」。
   */
  private async flush(peerId: string): Promise<void> {
    const pending = this.pending.get(peerId)
    if (pending === undefined) return
    this.pending.delete(peerId)
    if (pending.timer !== undefined) clearTimeout(pending.timer)

    try {
      const settings = await this.settingsFor(peerId)
      if (!settings.enabled) return

      const snapshot = await this.ensureSnapshot()
      const card = PersonaStore.resolve(settings.personaId ?? this.options.defaultPersona, snapshot)
      const first = !this.warmed.has(peerId)
      const plan = resolvePlan(card, settings)
      this.plans.set(peerId, plan)

      const memory = this.options.memory?.lineFor(peerId)
      const text = composeInboundText({
        card,
        peer: peerId,
        text: pending.texts.join('\n'),
        first,
        // 每轮都带表情名：库可能是会话开始后才填的。
        ...(await this.stickerHint()),
        ...(memory === undefined ? {} : { memory }),
        ...(this.options.timeZone === undefined ? {} : { timeZone: this.options.timeZone }),
        ...(this.options.now === undefined ? {} : { now: new Date(this.options.now()) }),
      })

      // 先记「已经暖过」再投递：投递失败重来时不该再灌一遍完整设定。
      this.warmed.add(peerId)

      // 媒体：能附上就附，附不上就把说明拼进文字——丢图可以，丢消息不行。
      let prepared: PreparedMedia = { parts: [], notes: [] }
      if (this.options.prepareMedia !== undefined && pending.items.length > 0) {
        try {
          prepared = await this.options.prepareMedia(pending.items, peerId)
        } catch (error) {
          this.options.report?.('媒体预处理失败', { error: String(error) })
        }
      }
      const notesText = prepared.notes.length === 0 ? '' : `\n${prepared.notes.join('\n')}`

      const userMessage = createUserMessage({
        content: [{ type: 'text', text: `${text}${notesText}` }, ...prepared.parts] as never,
        source: { kind: 'user' },
      })
      this.activity.touch(peerId, (this.options.now ?? Date.now)())
      this.turnCounts.set(peerId, (this.turnCounts.get(peerId) ?? 0) + 1)
      this.options.report?.(`投递给模型（合并 ${String(pending.texts.length)} 条）`)

      this.peerBySession.set(sessionIdFor(peerId, pending.generation), peerId)
      this.startProgress(peerId)
      await this.options.sessions.deliver(peerId, userMessage as never, pending.generation)
    } catch (error) {
      this.clearProgress(peerId)
      this.options.report?.('投递给模型失败', { peerId, error: String(error) })
      this.notice(peerId, '这条我没接上（会话没起来），再发一次试试。')
    }
  }

  /** 第一轮注入表情库名字；没有库就不注入（否则模型会编名字）。 */
  private async stickerHint(): Promise<{ stickers?: readonly string[] }> {
    if (this.options.stickerNames === undefined) return {}
    try {
      const names = await this.options.stickerNames()
      return names.length === 0 ? {} : { stickers: names }
    } catch {
      return {}
    }
  }

  /** 发一条系统提示（不分条、不占用回复形态）。 */
  private notice(peerId: string, text: string): void {
    const plan = this.plans.get(peerId) ?? DEFAULT_REPLY_PLAN
    void this.options.replies.enqueue(peerId, text, this.contextTokens.get(peerId), { ...plan, splitMode: 'none' }, { immediate: true })
  }

  /**
   * 起「还在弄」的定时器。
   *
   * 一轮用到工具时可能跑几分钟，这期间微信那头只有「正在输入」——
   * 超过半分钟没有任何输出，人就会怀疑它挂了。
   */
  private startProgress(peerId: string): void {
    this.clearProgress(peerId)
    const after = this.options.progressAfterMs ?? DEFAULT_PROGRESS_AFTER_MS
    if (after <= 0) return
    this.turnActive.add(peerId)
    const timer = setTimeout(() => {
      this.progress.delete(peerId)
      if (!this.turnActive.has(peerId)) return
      this.notice(peerId, '还在弄，稍等一下。')
    }, after)
    timer.unref?.()
    this.progress.set(peerId, timer)
  }

  private clearProgress(peerId: string): void {
    const timer = this.progress.get(peerId)
    if (timer !== undefined) clearTimeout(timer)
    this.progress.delete(peerId)
  }

  /** 人格快照：run 时加载一次；直接调 handle（测试/补投）时按需加载。 */
  private async ensureSnapshot(): Promise<PersonaSnapshot> {
    // 每次都扫：snapshot 内部按 mtime 判断，没变就是几次 stat，成本可以忽略。
    // 这样「改人格卡 → 下一条消息生效」，不必重启。
    this.snapshot = await this.options.personas.snapshot()
    return this.snapshot
  }

  /** 每个 peer 处理过的消息条数（/status 用）。 */
  private readonly turnCounts = new Map<string, number>()

  /**
   * 执行一条内置命令。
   *
   * 命令的回复走和模型回复同一条队列：这样限流、切分、失败提示都自动复用。
   */
  private async runCommand(peerId: string, command: { name: string; args: string[] }, generation: number, contextToken: string | undefined): Promise<void> {
    const reply = (text: string): void => {
      const started = (this.options.now ?? Date.now)()
      void this.options.replies.enqueue(peerId, text, contextToken, this.plans.get(peerId), { immediate: true })
        .then(() => this.options.report?.(`命令 /${command.name} 的回复已发出（${String((this.options.now ?? Date.now)() - started)}ms）`))
    }

    switch (command.name) {
      case 'help':
        reply(formatHelp())
        return

      case 'new': {
        if (this.options.generations === undefined) {
          reply('这个部署没有开启多段对话。')
          return
        }
        // 旧会话不 dispose：它的历史还在，只是这个聊天不再往那儿投递。
        const next = await this.options.generations.bump(peerId)
        // 新会话是空的，得重新注入完整人设；否则它只收到一行提醒，等于没人设。
        this.warmed.delete(peerId)
        reply(formatNewChat(next))
        this.options.report?.('开了新对话', { peerId, generation: next })
        return
      }

      case 'status': {
        const snapshot = await this.ensureSnapshot()
        const settings = this.options.settings === undefined ? DEFAULT_CHAT_SETTINGS : await this.options.settings.get(peerId)
        const card = PersonaStore.resolve(settings.personaId ?? this.options.defaultPersona, snapshot)
        const last = this.activity.get(peerId)
        const now = (this.options.now ?? Date.now)()
        reply(formatStatus({
          personaId: card.id,
          personaName: card.name,
          generation,
          turns: this.turnCounts.get(peerId) ?? 0,
          permission: this.options.permissionLabel ?? '未知',
          ...(last === undefined ? {} : { lastActive: formatAgo(now - last) }),
        }))
        return
      }

      case 'persona': {
        const snapshot = await this.ensureSnapshot()
        const choices = [...snapshot.personas.values()].map(persona => ({ id: persona.card.id, name: persona.card.name }))
        const settings = this.options.settings
        if (settings === undefined) {
          reply('这个部署没有可写的聊天设置。')
          return
        }
        if (command.args.length === 0) {
          const current = (await settings.get(peerId)).personaId ?? this.options.defaultPersona
          reply(formatPersona(current, choices))
          return
        }
        const wanted = command.args[0] ?? ''
        const found = choices.find(choice => choice.id === wanted)
        if (found === undefined) {
          reply(`没有「${wanted}」这张人格卡。\n\n${formatPersona(this.options.defaultPersona, choices)}`)
          return
        }
        const current = await settings.get(peerId)
        await settings.save(peerId, { ...current, personaId: found.id })
        reply(formatPersona(found.id, choices, found))
        return
      }

      case '表情': {
        const sub = command.args[0] ?? ''
        if (sub === '收' || sub === '收下') {
          const name = normalizeStickerName(command.args.slice(1).join(' '))
          if (name === undefined) {
            reply('用法：/表情 收 名字（名字不超过 24 字，不能带空格和方括号）')
            return
          }
          if (this.options.stickerInbox === undefined) {
            reply('这个部署没有表情库目录。')
            return
          }
          const saved = await this.options.stickerInbox.adopt(peerId, name)
          reply(saved === undefined
            ? '最近没有可收的图：先发一张图给我，再说 /表情 收 名字。'
            : `收好了：${saved}。之后它会用 [表情:${name}] 发这张。`)
          return
        }
        if (sub === '发' || sub === '发送') {
          const name = normalizeStickerName(command.args.slice(1).join(' '))
          if (name === undefined) {
            reply('用法：/表情 发 名字')
            return
          }
          const sent = await this.options.sendSticker?.(peerId, name, contextToken)
          reply(sent === true ? `已发出「${name}」。` : `没发出去：表情库里没有「${name}」。发 /表情 看有哪些。`)
          return
        }
        const names = this.options.stickerNames === undefined ? [] : await this.options.stickerNames()
        reply(names.length === 0
          ? '表情库是空的。把图片放进 stickers/ 目录（支持 png/jpg/gif/webp），或先发图再说「/表情 收 名字」。'
          : `表情库（${String(names.length)} 张）：\n${names.join('、')}\n\n发 /表情 发 名字 可以直接发一张。`)
        return
      }

      case 'menu': {
        await this.openMenu(peerId, 'root', contextToken)
        return
      }

      case 'stop': {
        // 打断跑偏的一轮：微信里没有别的办法让它停下来。
        this.clearProgress(peerId)
        this.turnActive.delete(peerId)
        const cancelled = await this.options.sessions.cancel(peerId, generation)
        reply(cancelled ? '已打断这一轮。' : '现在没有在跑的活。')
        return
      }

      case 'style': {
        // 分条方式以前只能手改 settings.json，等于没有；这条命令是它的入口。
        const settings = this.options.settings
        if (settings === undefined) {
          reply('这个部署没有可写的聊天设置。')
          return
        }
        const snapshot = await this.ensureSnapshot()
        const current = await settings.get(peerId)
        const card = PersonaStore.resolve(current.personaId ?? this.options.defaultPersona, snapshot)
        const plan = resolvePlan(card, current)
        const wanted = command.args[0]?.toLowerCase()

        if (wanted === undefined) {
          reply(formatStyle({
            maxChars: plan.softChars,
            split: plan.splitMode,
            maxBubbles: plan.maxBubbles,
            overridden: current.maxChars !== undefined || current.split !== undefined,
          }))
          return
        }

        if (wanted === 'reset') {
          const next = { ...current, maxChars: undefined, split: undefined }
          await settings.save(peerId, next)
          this.plans.set(peerId, resolvePlan(card, next))
          reply(`已恢复人格卡的分条方式：每条约 ${String(card.reply.maxChars)} 字，按${card.reply.split === 'sentence' ? '句子' : card.reply.split === 'none' ? '不切' : '段落'}切。`)
          return
        }

        if (wanted === 'sentence' || wanted === 'paragraph' || wanted === 'none') {
          const mode: ChatSettings['split'] = wanted
          const next = { ...current, split: mode }
          await settings.save(peerId, next)
          this.plans.set(peerId, resolvePlan(card, next))
          reply(`分条改成按${wanted === 'sentence' ? '句子' : wanted === 'none' ? '不切' : '段落'}切，下一条生效。`)
          return
        }

        const chars = Number(wanted)
        if (!Number.isFinite(chars)) {
          reply('用法：/style 160（改字数）、/style sentence（按句切）、/style none（不切）、/style reset（恢复人格卡）。')
          return
        }
        const clamped = Math.round(Math.min(4_096, Math.max(20, chars)))
        const next = { ...current, maxChars: clamped }
        await settings.save(peerId, next)
        this.plans.set(peerId, resolvePlan(card, next))
        reply(`每条最多 ${String(clamped)} 字，下一条生效。`)
        return
      }

      default:
        reply(formatUnknown(command.name))
    }
  }

  /** 读某个 peer 的最近活跃时间（毫秒）；没说过话返回 undefined。 */
  lastSeen(peerId: string): number | undefined {
    return this.activity.get(peerId)
  }

  /**
   * 这个 chat 最近一条入站消息的 context_token。
   *
   * 审批提示要在「模型正在跑」的时候发出去，这时没有新消息可回，
   * 只能沿用上一条的令牌。
   */
  contextTokenFor(peerId: string): string | undefined {
    return this.contextTokens.get(peerId)
  }

  /**
   * 挂上审批桥。
   *
   * 桥要用回复队列和上下文令牌，而这两样都要等通道造好才有；
   * 所以不放进构造参数，而是造好后回填一次。
   */
  setApprovals(approvals: NonNullable<ChannelOptions['approvals']>): void {
    this.options.approvals = approvals
  }

  /** 会话 id → peer id；审批请求只带 agent，不带 peer。 */
  peerForSession(sessionId: string): string | undefined {
    return this.peerBySession.get(sessionId)
  }

  /** 已知的 peer 列表（说过话的）。 */
  knownPeers(): readonly string[] {
    return this.activity.peers()
  }

  /**
   * 记一次活跃。
   *
   * 正常路径由入站消息触发；这个公开入口给定时器与测试用——
   * 主动搭话的判定必须能脱离「刚好收到一条消息」来测。
   */
  markActive(peerId: string, at: number): void {
    this.activity.touch(peerId, at)
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
      lastSeenAt: this.activity.get(peerId),
      minIdleHours: card.proactive.minIdleHours,
      quietHours: card.proactive.quietHours,
      enabled: settings.proactive && settings.enabled && card.proactive.enabled,
    })
    if (!allowed) return false

    const plan = resolvePlan(card, settings)
    this.plans.set(peerId, plan)
    const text = composeInboundText({ card, peer: peerId, text: proactiveInstruction(), first: false })
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    // 先记时间再投递：投递失败也不该在下一分钟后重复轰炸。
    this.activity.touch(peerId, now)
    this.startProgress(peerId)
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

  private subscribeReplies(): void {
    this.unsubscribe = this.options.events.on('session/event', (session, event) => {
      const peerId = this.peerBySession.get(String(session.id))
      if (peerId === undefined) return

      const type = isRecord(event) ? event['type'] : undefined
      // 一轮结束是本文件唯一能知道「失败/被审批卡住」的地方：
      // 只看 assistant/message 的话，模型报错时微信那头是一片沉默。
      if (type === 'turn/end') {
        this.onTurnEnd(peerId, event)
        return
      }
      // 模型用 present 交付文件：图片之外的东西（docx/pdf/zip）走这条。
      if (type === 'deliverables/presented') {
        void this.handlePresented(peerId, event)
        return
      }

      const text = extractAssistantText(event)
      if (text === undefined) return
      // 有正式回答就说明这轮还活着，别再补「还在弄」。
      this.clearProgress(peerId)
      this.turnActive.delete(peerId)
      // 「记住」标记是给通道看的：先摘掉再发，用户不该看到它。
      const recalled = extractMemoryMarkers(text)
      if (recalled.facts.length > 0) {
        void this.options.memory?.remember(peerId, recalled.facts).catch((error: unknown) => {
          this.options.report?.('记忆写入失败', { error: String(error) })
        })
      }
      // 位置：协议没有位置消息，只能展开成「名字 + 地图链接」。
      const body = expandLocationTokens(recalled.text)
      if (body === '') return

      const token = this.contextTokens.get(peerId)
      const plan = this.plans.get(peerId)

      // 表情：模型写了 `[表情:名字]` 就先发图，再把剩下的文字发出去。
      // 图没发成功就退化成文字，绝不让整条回复消失。
      const sticker = parseStickerToken(body)
      const sendSticker = this.options.sendSticker
      if (sticker !== undefined && sendSticker !== undefined) {
        void (async () => {
          const sent = await sendSticker(peerId, sticker.name, token).catch((error: unknown) => {
            this.options.report?.('表情发送失败', { name: sticker.name, error: String(error) })
            return false
          })
          const rest = sent ? sticker.text : body.replace(/\[表情[:：][^\]]*\]/gu, '').trim()
          if (rest !== '') await this.options.replies.enqueue(peerId, rest, token, plan)
        })()
        return
      }

      const queuedAt = (this.options.now ?? Date.now)()
      void this.options.replies.enqueue(peerId, body, token, plan).then(() => {
        this.options.report?.(`回复已发出（模型出字到发完 ${String((this.options.now ?? Date.now)() - queuedAt)}ms）`)
      })
    })
  }

  /**
   * 模型要求「交付」文件时，把它们发到微信。
   *
   * 这是「能干活」的闭环：以前的会话能生成 docx，却只能回一句「文件在桌面上」。
   * 事件给的是相对路径（相对会话 cwd），这里补全成绝对路径再交给宿主。
   */
  private async handlePresented(peerId: string, event: unknown): Promise<void> {
    const send = this.options.sendFiles
    if (send === undefined) return

    const data = isRecord(event) ? event['data'] : undefined
    const files = isRecord(data) ? data['files'] : undefined
    if (!Array.isArray(files)) return

    const paths: string[] = []
    for (const item of files) {
      const path = isRecord(item) && typeof item['path'] === 'string' ? item['path'].trim() : ''
      if (path === '') continue
      paths.push(isAbsolute(path) || this.options.cwd === undefined ? path : resolve(this.options.cwd, path))
    }
    if (paths.length === 0) return

    this.clearProgress(peerId)
    try {
      await send(peerId, paths, this.contextTokens.get(peerId))
      this.options.report?.('已发送文件', { peerId, count: paths.length })
    } catch (error) {
      this.options.report?.('发送文件失败', { peerId, error: String(error) })
      this.notice(peerId, `文件没发出去：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 一轮结束时的收尾与反馈。
   *
   * `turn/end.reason.kind` 的取值来自 session 的事件定义：
   * `error` / `blocked` / `max-tokens` / `aborted`。以前一个都没接，
   * 于是「模型报错」「等你审批」「被截断」在微信里全都表现为「已读不回」。
   */
  private onTurnEnd(peerId: string, event: unknown): void {
    this.clearProgress(peerId)
    this.turnActive.delete(peerId)
    // 一轮结束时还挂着的审批永远不会有人答了，直接判取消，别让它拖到超时。
    this.options.approvals?.cancel(peerId)

    const data = isRecord(event) ? event['data'] : undefined
    const reason = isRecord(data) ? data['reason'] : undefined
    const kind = isRecord(reason) ? reason['kind'] : undefined

    switch (kind) {
      case 'error': {
        const failure = isRecord(reason) ? reason['error'] : undefined
        const message = isRecord(failure) && typeof failure['message'] === 'string' ? failure['message'] : ''
        this.options.report?.('这一轮失败', { peerId, message })
        this.notice(peerId, message === '' ? '这一轮没跑通，等会儿再试一次？' : `这一轮没跑通：${message}`)
        return
      }
      case 'blocked':
        // 这个 reason 不是「等审批」：它来自 agent 前置条件（会话已归档、目标轮次过期）。
        // 审批不会结束一轮——它挂在这一步的工具调用里，答复后继续。
        this.notice(peerId, '这一轮被前置条件挡下了（会话可能已归档），可以发 /new 重开一段。')
        return
      case 'max-tokens':
        this.notice(peerId, '回答到长度上限断了，让我接着说就行。')
        return
      case 'aborted':
        this.notice(peerId, '这一轮被中断了。')
        return
      default:
        return
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 传输层超时（我们自己的 hold 到点了），不是服务端拒绝。 */
function isTimeout(error: unknown): boolean {
  const classification = (error as { classification?: { type?: string } } | null)?.classification
  return classification?.type === 'timeout'
}
