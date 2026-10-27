/**
 * wechat-persona — 微信里的「AI 联系人」通道（DSH 插件）。
 *
 * Coordinator 管理账号、通道生命周期和各业务服务的装配。
 * Cordis 注册在 plugin.ts，网页路由注册在 panel/register.ts。
 *
 * @module wechat-persona
 */

import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

import type { Config as ConfigShape } from '../../../../src/app/config.ts'
import { createApiClient } from '../../../../src/ilink/api.ts'
import type { LoginCredentials } from '../../../../src/ilink/login-machine.ts'
import { forgetAccount, loadAccount, saveAccount, type StoredAccount } from '../../../../src/auth/credentials.ts'
import { PersonaStore } from '../../../../src/persona/store.ts'
import { ChatSettingsStore } from '../../../../src/chat/settings.ts'
import { StickerLibrary } from '../../../../src/stickers/library.ts'
import { sendImage } from '../../../../src/ilink/send-image.ts'
import { sendFile } from '../../../../src/ilink/send-file.ts'
import { createAccessPolicy } from '../../../../src/wechat/access.ts'
import { ApprovalBridge } from '../../../../src/dsh/approvals.ts'
import { PeerActivity } from '../../../../src/chat/activity.ts'
import { PeerMemory } from '../../../../src/memory/store.ts'
import { SettingsRepository } from '../panel/repository.ts'
import { ConversationStore } from '../../../../src/chat/history.ts'
import { PeerSystemPrompt } from '../../../../src/dsh/system-prompt.ts'
import { ReplyQueue, type SendContext } from '../../../../src/reply/queue.ts'
import { createMediaPreparer, type AttachmentStoreLike, type PreparedMedia } from '../../../../src/dsh/attachments.ts'
import { compactPeer, type CompactionEngineLike } from '../../../../src/dsh/compaction.ts'
import { WorkspaceGrouper, type SessionPersistenceLike, type WorkspaceRegistryLike } from '../../../../src/dsh/workspace.ts'
import type { MessageItem } from '../../../../src/ilink/types.ts'
import { PeerSessions, SESSION_ID_PREFIX, type AgentHandleLike, type AgentRegistryLike } from '../../../../src/dsh/sessions.ts'
import { PeerGenerations } from '../../../../src/chat/generations.ts'
import { Channel } from '../wechat/channel.ts'
import { TypingIndicator } from '../../../../src/wechat/typing.ts'
import { createFileLogger, type FileLogger } from '../../../../src/app/logger.ts'
import { LoginSession } from '../auth/session.ts'
import type { ChatPatch, ChatSummary, PanelHandlers, PanelStatus, PersonaSummary } from '../panel/routes.ts'
import type { SettingsLinks } from '../panel/server.ts'
import { renderQrSvg } from '../auth/qr.ts'

import { name } from '../../../../src/app/identity.ts'

/** 本构建声明的版本，进 `channel_version` 头。 */
const CHANNEL_VERSION = '0.3.0-dev.0'

/** 单个出站文件的上限：整份文件一次性读进内存，再大就会把进程拖垮。 */
const MAX_SEND_FILE_BYTES = 100 * 1024 * 1024

/** iLink 的登录基址；确认后服务端会给出后续 baseurl。 */
const LOGIN_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** `ctx.agents` 的注册面。 */
type AgentsLike = AgentRegistryLike

/** 审批结论；与 DSH 的 `ApprovalOutcome` 对齐。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** `ctx.sessionPersistence` 里我们用到的部分。 */
interface PersistenceLike {
  stat: (id: string, options?: { signal?: AbortSignal }) => Promise<unknown>
}

/**
 * `ctx.agentPresets` 里我们用到的部分。
 *
 * 结构化声明而非导入：headless 等组合没有 preset 注册表，`inject` 会把整行 park 在那里。
 */
interface AgentPresetsLike {
  resolve: (id?: string) => Promise<{ readonly id: string }>
  mount: (agentCtx: unknown, id?: string) => Promise<unknown>
}

/** `ctx.llm` 里我们用到的部分。 */
interface LlmLike {
  resolveModelInfo: (provider: string, model: string) => Promise<{ inputModalities?: readonly string[] } | undefined>
}

interface ModelDefaultsLike {
  currentSelection: () => { provider: string; model: string }
}

/**
 * 一次通道运行。放在类里而不是模块级，是为了 profile 重载时不共享死掉的 run。
 */
export class Coordinator {
  private readonly ctx: Context
  private readonly config: ConfigShape
  private readonly dataDir: string
  private readonly repository: SettingsRepository
  private readonly store: PersonaStore
  private readonly chatSettings: ChatSettingsStore
  private readonly stickers: StickerLibrary
  private readonly generations: PeerGenerations
  private readonly activity: PeerActivity
  private readonly memory: PeerMemory
  private readonly fileLog: FileLogger
  private readonly report: (line: string, detail?: unknown) => void
  private registry: AgentsLike | undefined
  private accountWatcher: FSWatcher | undefined
  private account: StoredAccount | undefined
  private run: Channel | undefined
  private prompts: PeerSystemPrompt | undefined
  private approvals: ApprovalBridge | undefined
  private starting = false
  private settingsLinks: SettingsLinks | undefined
  private readonly login: LoginSession

  constructor(ctx: Context, config: ConfigShape, dataDir: string) {
    this.ctx = ctx
    this.config = config
    this.dataDir = dataDir
    this.report = (line, detail) => {
      const logger = ctx.logger(name)
      const text = detail === undefined ? line : `${line} ${JSON.stringify(detail)}`
      if (detail === undefined) logger.info(line)
      else logger.warn(text)
      // 同时落一份自己的文件：宿主日志会滚，出问题时用户能直接发这个文件。
      if (detail === undefined) this.fileLog.info(text)
      else this.fileLog.warn(text)
    }
    this.repository = new SettingsRepository(dataDir)
    this.store = this.repository.personas
    this.chatSettings = this.repository.settings
    this.stickers = this.repository.stickers
    this.generations = new PeerGenerations(join(dataDir, 'generations.json'))
    // 聊天列表和最后活跃时间在重启后保留。
    this.activity = new PeerActivity(join(dataDir, 'last-seen.json'))
    this.memory = this.repository.memory
    this.fileLog = createFileLogger({ dir: join(dataDir, 'logs'), retentionDays: config.logRetentionDays.get() })
    this.login = new LoginSession({
      api: createApiClient({ channelVersion: CHANNEL_VERSION, botAgent: 'wechat-persona' }),
      renderQr: renderQrSvg,
      onConnected: async credentials => { await this.connect(credentials) },
      report: this.report,
    })
  }

  /** 设置页固定地址；登录通过一次性票据，不在日志中记录凭据。 */
  announcePanel(links: SettingsLinks | undefined): void {
    this.settingsLinks = links
    if (links) this.report(`设置页：${links.localUrl}`)
  }

  /** 启动时打一行：证明插件被加载了、用的是哪个目录。 */
  announceBoot(detail: string): void {
    this.report(`已加载 ${detail}`)
  }

  /** 宿主 agents 服务到位后调用：恢复账号并开跑。 */
  async attach(registry: AgentsLike): Promise<void> {
    this.registry = registry
    this.account = await loadAccount(this.dataDir)
    this.watchAccount()
    if (this.account !== undefined) await this.startRun()
  }

  /**
   * 监听凭据文件：终端登录（scripts/login.ts）写完后，正在运行的 DSH 不需要重启。
   *
   * 只认 `account.json`，且只在内容真的变了才重启通道——否则自己写游标的噪音也会触发。
   */
  private watchAccount(): void {
    if (this.accountWatcher !== undefined) return
    try {
      this.accountWatcher = watch(this.dataDir, (_event, filename) => {
        if (filename !== 'account.json') return
        void this.refreshAccount().catch((error: unknown) => {
          this.report('重新加载账号失败', { error: String(error) })
        })
      })
      this.accountWatcher.unref?.()
    } catch (error) {
      this.report('无法监听账号文件（不影响已登录的会话）', { error: String(error) })
    }
  }

  /**
   * 重新读账号：出现/变化就（重）启通道，消失就停。
   */
  async refreshAccount(): Promise<void> {
    const next = await loadAccount(this.dataDir)
    if (next === undefined) {
      if (this.account !== undefined) {
        this.account = undefined
        await this.stopRun()
        this.login.markExpired()
        this.report('账号文件已删除，通道已停止')
      }
      return
    }
    if (this.account !== undefined && this.account.botToken === next.botToken && this.account.accountId === next.accountId) return
    this.account = next
    this.report('检测到新登录，启动通道', { accountId: next.accountId })
    await this.startRun()
  }

  /** 登录成功：落盘 + 开跑。 */
  async connect(credentials: LoginCredentials): Promise<void> {
    this.account = await saveAccount(this.dataDir, {
      accountId: credentials.accountId,
      baseUrl: credentials.baseUrl === LOGIN_BASE_URL ? credentials.baseUrl : credentials.baseUrl,
      botToken: credentials.botToken,
      ...(credentials.userId === undefined ? {} : { userId: credentials.userId }),
    })
    this.report('微信已连接', { accountId: credentials.accountId })
    await this.startRun()
  }

  /**
   * 审批 waterfall 的答复者。
   *
   * 只认本通道造的会话；其余交回 `next()`（GUI 的审批卡）。
   * 返回 `unavailable` 会让这一步失败，所以只有真的问不到人时才这样。
   */
  async answerApproval(
    request: { agent: { id: unknown }; toolName: string; reason?: string; displayReason?: Record<string, string> },
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const sessionId = String(request.agent?.id ?? '')
    if (!sessionId.startsWith(SESSION_ID_PREFIX)) return await next()
    const peerId = this.run?.peerForSession(sessionId)
    if (peerId === undefined || this.approvals === undefined) return await next()

    const reason = request.displayReason?.['zh'] ?? request.reason
    const answer = await this.approvals.request({
      peerId,
      toolName: request.toolName,
      ...(reason === undefined ? {} : { reason }),
    })
    this.report('审批已答复', { peerId, toolName: request.toolName, answer })
    return answer === 'allow' ? 'allowed-once' : answer === 'deny' ? 'rejected' : 'cancelled'
  }

  /** 退出登录：停轮询、删凭据、复位面板。 */
  async logout(): Promise<void> {
    await this.stopRun()
    await forgetAccount(this.dataDir)
    this.account = undefined
    this.login.reset()
  }

  /** 面板状态。 */
  async status(): Promise<PanelStatus> {
    return {
      connected: this.account !== undefined && this.run !== undefined,
      ...(this.account?.userId === undefined ? {} : { userId: this.account.userId }),
      login: this.login.view(),
      dataDir: this.dataDir,
    }
  }

  async personas(): Promise<PersonaSummary[]> { return await this.repository.listPersonas() }
  async readPersona(id: string) { return await this.repository.readPersona(id) }
  async writePersona(id: string,raw: string) { return await this.repository.writePersona(id,raw) }
  async chats(): Promise<ChatSummary[]> { return await this.repository.chats(this.run?.knownPeers()) }
  async setChat(patch: ChatPatch): Promise<ChatSummary> { return await this.repository.setChat(patch) }

  /** DSH 只提供在线能力，数据层不依赖宿主生命周期。 */
  panelHandlers(): PanelHandlers {
    return this.repository.handlers({
      control: async (peerId,action) => this.run ? {ok:true,message:await this.run.control(peerId,action)} : {ok:false,message:'Bot 当前离线。'},
      status: async () => ({...await this.status(),botOnline:!!this.run && !!this.account}),
      begin: async () => await this.login.begin(),
      poll: async () => await this.login.poll(),
      verifyCode: code => Promise.resolve(this.login.submitVerifyCode(code)).then(() => this.login.poll()),
      logout: async () => { await this.logout(); return this.login.view() },
    },() => this.run?.knownPeers() ?? [])
  }

  private async startRun(): Promise<void> {
    if (this.registry === undefined || this.account === undefined || this.starting) return
    await this.memory.load()
    this.starting = true
    try {
      await this.stopRun()
      const account = this.account
      const registry = this.registry
      const access = createAccessPolicy({ allow: this.config.allow.get(), owner: account.userId })
      if (!access.admitsAnyone()) {
        this.report('没有任何 peer 被放行：请在插件配置的 allow 里填微信 id')
        return
      }

      const preset = this.config.permission.get()
      // 挂 preset 是这个通道能不能「干活」的分水岭：web app 把工具行都藏在 preset 后面。
      const presets = this.ctx.get('agentPresets') as AgentPresetsLike | undefined
      const agentPreset = presets === undefined ? undefined : (await presets.resolve()).id
      if (presets === undefined) {
        this.report('宿主没有 agent preset 注册表：这个会话将只有极少的工具')
      } else {
        this.report('会话将挂载 preset', { agentPreset })
      }
      const history = new ConversationStore(join(this.dataDir, 'conversations', createHash('sha256').update(account.accountId).digest('hex')))
      // 会话列表按工作区分组；本插件的会话有自己的 cwd，要主动挂一次。
      const grouper = new WorkspaceGrouper({
        registry: () => this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined,
        persistence: () => this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined,
        cwd: this.config.cwd.get(),
        title: '微信',
        report: this.report,
      })
      let channel: Channel
      const prompts = new PeerSystemPrompt({
        personas: this.store,
        settings: this.chatSettings,
        defaultPersona: () => this.config.defaultPersona.get(),
        memory: this.memory,
        stickers: this.stickers,
        history,
        activity: peerId => channel?.memoryActivity(peerId),
        conversationContext: async peerId => await channel.context(peerId),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        report: this.report,
      })
      this.prompts = prompts
      const sessions = new PeerSessions({
        registry,
        cwd: this.config.cwd.get(),
        sessionOptions: this.modelSelection(),
        sessionExists: async id => await this.sessionExists(id),
        onError: error => { this.report('会话释放失败', { error: String(error) }) },
        // 每个会话单独记权限：只影响这个通道造的会话，不动 profile 的全局默认。
        onHandle: (handle, peerId) => {
          // 已被 GUI 启动的会话不会执行 setup，也必须挂上当前通道的人设。
          if (handle.agent.ctx === undefined) throw new Error('宿主 agent 缺少会话作用域')
          prompts.install(handle.agent.ctx, handle.agent, peerId)
          this.applyPermission(handle, preset)
          void grouper.attach(String(handle.agent.id))
        },
        setup: async (agentCtx, agent, peerId) => {
          const header = (agent as { session?: { header?: { agentPreset?: string } } }).session?.header
          await presets?.mount(agentCtx, header?.agentPreset ?? agentPreset)
          prompts.install(agentCtx as Context, agent as object, peerId)
        },
        ...(agentPreset === undefined ? {} : { agentPreset }),
      })
      const api = createApiClient({ channelVersion: CHANNEL_VERSION, botAgent: 'wechat-persona' })
      const typing = new TypingIndicator({ api, baseUrl: account.baseUrl, token: account.botToken, report: this.report })
      const replies = new ReplyQueue({
        history,
        sendSticker: async (peerId, stickerName, contextToken, context) => await this.sendSticker(peerId, stickerName, contextToken, context),
        sendFile: async (peerId, path, token, context) => await this.sendFile(peerId, path, token, context),
        send: async (peerId, text, contextToken, context) => {
          await api.sendText({
            baseUrl: account.baseUrl,
            endpoint: 'ilink/bot/sendmessage',
            label: 'sendmessage',
            token: account.botToken,
            to: peerId,
            text,
            clientId: context.clientId,
            signal: context.signal,
            ...(contextToken === undefined ? {} : { contextToken }),
          })
        },
        // Refresh typing between ordered delivery units.
        onChunk: peerId => { void typing.start(peerId) },
        onSlowSend: (peerId, spent, chars) => { this.report('单次发送很慢', { peerId, spent, chars }) },
        // 一条回复（可能好几个气泡）彻底发完才收尾——否则气泡之间会一闪一闪。
        onDrain: peerId => { void typing.stop(peerId) },
        onGiveUp: (peerId, text, error) => {
          this.report('回复最终失败', { peerId, chars: text.length, error: String(error) })
          // The durable delivery outcome is shown to the next model request.
          // A direct fallback would bypass ordering and cancellation.
        },
        // 1 秒是「同一条回复的相邻气泡」的节奏；真正的限流由 ret:-2 的退避兜住。
        minIntervalMs: 1_000,
      })

      channel = new Channel({
        settingsUrl: peerId => this.settingsLinks?.forPeer(peerId, peerId === this.account?.userId),
        history,
        api,
        account: { baseUrl: account.baseUrl, token: account.botToken, userId: account.userId },
        sessions,
        access,
        personas: this.store,
        defaultPersona: this.config.defaultPersona.get(),
        settings: this.chatSettings,
        generations: this.generations,
        permissionLabel: preset,
        activity: this.activity,
        memory: this.memory,
        modelLabel: this.modelLabel(),
        cwd: this.config.cwd.get(),
        stickers: this.stickers,
        sendSticker: async (peerId, stickerName, contextToken) => await this.sendSticker(peerId, stickerName, contextToken),
        typing,
        replies,
        events: this.ctx as never,
        report: this.report,
        // 服务端说 token 废了：清掉本地账号，页面回到「可以重新扫码」的状态。
        onSessionExpired: () => {
          this.account = undefined
          void forgetAccount(this.dataDir)
          this.login.markExpired()
        },
        prepareMedia: this.mediaPreparer(),
        compact: async (peerId, generation, signal) => await compactPeer({
          signal,
          engine: this.ctx.get('compaction') as CompactionEngineLike | undefined,
          agentAt: async (id, gen) => await sessions.agentAt(id, gen),
          peerId,
          generation,
          report: this.report,
        }),
        // 一轮跑完时会话一定已落盘，这时把它归入工作区最稳。
        onSessionSettled: sessionId => { void grouper.attach(sessionId) },
        // 调查协议未公开场景时打开：逐条记入站报文形状。
        diagnoseMessages: this.config.diagnoseMessages.get(),
      })
      // 审批桥：把「要不要执行」发到微信，等一句 1/2。
      // 只有会话的审批策略是 ask 时才会被调用；danger-full-access 下服务端直接放行/拒绝。
      const approvals = new ApprovalBridge({
        // 审批提示要立刻出现：用户正等着决定，不该先「想」两秒。
        ask: async (peerId, text) => { const outcome = await replies.enqueue(peerId, text, channel.contextTokenFor(peerId), undefined, { immediate: true }); if (outcome.status !== 'accepted') throw new Error('审批提示未确认发出') },
        report: this.report,
      })
      this.approvals = approvals
      channel.setApprovals(approvals)

      const cursor = await this.readCursor(account.accountId)
      this.run = channel
      this.report(`开始轮询（账号 ${account.accountId}）`)

      // 不 await：循环跑到 stop 为止；失败要落日志而不是变成未处理的 rejection。
      void channel.run(cursor).catch((error: unknown) => { this.report('通道停止', { error: String(error) }) })

      // 把上一轮运行留下的会话从「未分组」补齐到工作区。
      // 工作区服务比本插件晚就绪，所以立即扫一次、过几秒再扫一次；
      // 只有第二次仍拿不到服务，才判定为「宿主没有工作区」。
      const sweepOnce = async (reportUnavailable: boolean): Promise<void> => {
        const count = await grouper.sweep()
        if (count > 0) this.report('已有会话归入工作区', { title: '微信', count })
        else if (reportUnavailable && !grouper.available) this.report('宿主没有工作区注册表：微信会话会显示在「未分组」下')
      }
      void sweepOnce(false)
      const groupTimer = setTimeout(() => { void sweepOnce(true) }, 5_000)
      groupTimer.unref?.()
      this.groupTimer = groupTimer

      // 游标定期落盘：重启后不重放已经回过的消息。
      const timer = setInterval(() => {
        const current = channel.getCursor()
        if (current !== undefined && current !== cursor) void this.writeCursor(account.accountId, current)
      }, 5_000)
      timer.unref()
      this.cursorTimer = timer
    } finally {
      this.starting = false
    }
  }

  private cursorTimer: NodeJS.Timeout | undefined

  /** 延后补扫工作区分组的定时器。 */
  private groupTimer: NodeJS.Timeout | undefined

  private async stopRun(): Promise<void> {
    if (this.cursorTimer !== undefined) {
      clearInterval(this.cursorTimer)
      this.cursorTimer = undefined
    }
    if (this.groupTimer !== undefined) {
      clearTimeout(this.groupTimer)
      this.groupTimer = undefined
    }
    this.approvals?.cancelAll()
    const run = this.run
    this.run = undefined
    if (run !== undefined) await run.stop()
    this.prompts?.dispose()
    this.prompts = undefined
  }

  /** 媒体处理不依赖视觉能力：原件总是先保存，视觉输入按宿主/模型能力决定。 */
  private mediaPreparer(): (items: readonly MessageItem[], peerId?: string) => Promise<PreparedMedia> {
    const store = this.ctx.get('attachments') as AttachmentStoreLike | undefined
    const selection = this.modelSelection()
    return createMediaPreparer({
      store,
      supportsImage: async () => {
        const llm = this.ctx.get('llm') as LlmLike | undefined
        if (llm === undefined) return false
        try {
          const info = await llm.resolveModelInfo(selection.provider ?? '', selection.model ?? '')
          return info?.inputModalities?.includes('image') ?? false
        } catch {
          return false
        }
      },
      report: this.report,
      // 收到图片便保留原件；只有模型确认是表情或用户显式收藏后才可回发。
      onImage: async ({ data, mediaType, peerId }) => {
        if (peerId === undefined) return
        return (await this.stickers.capture(peerId, data, mediaType))?.id
      },
    })
  }

  /**
   * 给一个会话记录权限预设。
   *
   * 记在 session 上（append 一条 session 内的 knob 事件），所以 GUI 的会话与全局默认都不受影响。
   * 失败只记录：它发生在会话创建路径上，抛出去会让用户等的那条消息没有下文。
   */
  private applyPermission(handle: AgentHandleLike, preset: string): void {
    const permissions = this.ctx.get('permissionPresets') as { set: (session: unknown, name: string) => void } | undefined
    if (permissions === undefined) {
      this.report('宿主没有权限预设服务，会话沿用默认档位', { preset })
      return
    }
    const session = handle.agent.session
    if (session === undefined) return
    try {
      permissions.set(session, preset)
      this.report('会话权限已设置', { preset })
    } catch (error) {
      this.report('设置会话权限失败，沿用默认档位', { preset, error: String(error) })
    }
  }

  /**
   * 把一个本地文件发进微信。
   *
   * 上限 100 MiB：协议本身没写限制，但整份文件是一次性读进内存、一次性 POST 的，
   * 更大的文件在这个实现里只会把进程拖垮。宁可回一句「太大了」。
   */
  private async sendFile(peerId: string, path: string, contextToken: string | undefined, context?: SendContext): Promise<void> {
    if (this.account === undefined) throw new Error('还没登录')
    const size = (await stat(path)).size
    if (size > MAX_SEND_FILE_BYTES) {
      throw new Error(`${basename(path)} 有 ${(size / 1024 / 1024).toFixed(1)} MB，超过 100 MB 发不了`)
    }
    const data = await readFile(path)
    await sendFile({
      api: createApiClient({ channelVersion: CHANNEL_VERSION, botAgent: 'wechat-persona' }),
      baseUrl: this.account.baseUrl,
      token: this.account.botToken,
      to: peerId,
      data,
      fileName: basename(path),
      clientId: context?.clientId,
      signal: context?.signal,
      ...(contextToken === undefined ? {} : { contextToken }),
    })
  }

  /** 发一张本地表情：找到文件、读出来、走图片发送。 */
  private async sendSticker(peerId: string, stickerName: string, contextToken: string | undefined, context?: SendContext): Promise<boolean> {
    if (this.account === undefined) return false
    const file = await this.stickers.find(stickerName, peerId)
    if (file === undefined) {
      this.report('表情库里没有这张，按文字发', { name: stickerName })
      return false
    }
    const data = await readFile(file)
    await sendImage({
      api: createApiClient({ channelVersion: CHANNEL_VERSION, botAgent: 'wechat-persona' }),
      baseUrl: this.account.baseUrl,
      token: this.account.botToken,
      to: peerId,
      ...(contextToken === undefined ? {} : { contextToken }),
      data,
      clientId: context?.clientId,
      signal: context?.signal,
    })
    return true
  }

  /** 卡片上展示的模型名；拿不到就空串。 */
  private modelLabel(): string {
    const selection = this.modelSelection()
    if (selection.model === undefined) return ''
    return selection.model
  }

  private modelSelection(): { provider?: string; model?: string } {
    const defaults = this.ctx.get('agentDefaultModel') as ModelDefaultsLike | undefined
    if (defaults === undefined) return {}
    try {
      const selection = defaults.currentSelection()
      return { provider: selection.provider, model: selection.model }
    } catch {
      return {}
    }
  }

  private async sessionExists(sessionId: string): Promise<boolean> {
    const persistence = this.ctx.get('sessionPersistence') as PersistenceLike | undefined
    if (persistence === undefined) return false
    try {
      return (await persistence.stat(sessionId)) !== undefined
    } catch {
      // 读不出来就当存在：宁可 resume（会自己报错）也不要在有历史的会话上 create。
      return true
    }
  }

  private async readCursor(accountId: string): Promise<string | undefined> {
    try {
      const raw = await readFile(join(this.dataDir, 'cursor.json'), 'utf8')
      const parsed = JSON.parse(raw) as Record<string, string>
      return parsed[accountId]
    } catch {
      return undefined
    }
  }

  private async writeCursor(accountId: string, cursor: string): Promise<void> {
    try {
      let current: Record<string, string> = {}
      try {
        current = JSON.parse(await readFile(join(this.dataDir, 'cursor.json'), 'utf8')) as Record<string, string>
      } catch {
        current = {}
      }
      current[accountId] = cursor
      await writeFile(join(this.dataDir, 'cursor.json'), JSON.stringify(current, null, 2), 'utf8')
    } catch (error) {
      this.report('游标落盘失败', { error: String(error) })
    }
  }

  /** 卸载时停掉一切。 */
  async dispose(): Promise<void> {
    this.accountWatcher?.close()
    this.accountWatcher = undefined
    this.approvals?.cancelAll()
    await this.stopRun()
  }
}
