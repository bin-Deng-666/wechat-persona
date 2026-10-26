/**
 * wechat-persona — 微信里的「AI 联系人」通道（DSH 插件）。
 *
 * 接线全在 `Coordinator` 里：登录状态、账号、通道运行、面板。
 * 业务判断都在 `ilink/`、`bridge/`、`channel/` 与 `persona/`，这里不做判断。
 *
 * @module wechat-persona
 */

import { isAbsolute, join, resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'

import { Config } from './config.ts'
import type { Config as ConfigShape } from './config.ts'
import { createApiClient } from './ilink/api.ts'
import type { LoginCredentials } from './ilink/login-machine.ts'
import { forgetAccount, loadAccount, saveAccount, type StoredAccount } from './credentials.ts'
import { PersonaStore } from './persona/store.ts'
import { createAccessPolicy } from './bridge/access.ts'
import { ReplyQueue } from './bridge/reply.ts'
import { PeerSessions, type AgentRegistryLike } from './bridge/session.ts'
import { Channel } from './channel/runtime.ts'
import { LoginSession } from './channel/login-session.ts'
import { createPanel, PANEL_PATH, PANEL_PREFIX, type PanelStatus, type PersonaSummary } from './channel/panel.ts'
import { renderQrSvg } from './channel/qr.ts'

export { Config }

/** 启动审计里报告的名字。 */
export const name = 'persona-wechat'

/** 本构建声明的版本，进 `channel_version` 头。 */
const CHANNEL_VERSION = '0.1.0'

/** iLink 的登录基址；确认后服务端会给出后续 baseurl。 */
const LOGIN_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** 宿主提供的浏览器路由表。 */
interface ConnectionLike {
  fetch: {
    register: (route: {
      path: string
      methods: readonly string[]
      requestBody: string
      fetch: (request: Request) => Promise<Response>
    }) => () => void
  }
}

/** `ctx.agents` 的注册面。 */
type AgentsLike = AgentRegistryLike

/** `ctx.sessionPersistence` 里我们用到的部分。 */
interface PersistenceLike {
  stat: (id: string, options?: { signal?: AbortSignal }) => Promise<unknown>
}

interface ModelDefaultsLike {
  currentSelection: () => { provider: string; model: string }
}

/**
 * 一次通道运行。放在类里而不是模块级，是为了 profile 重载时不共享死掉的 run。
 */
class Coordinator {
  private readonly ctx: Context
  private readonly config: ConfigShape
  private readonly dataDir: string
  private readonly store: PersonaStore
  private readonly report: (line: string, detail?: unknown) => void
  private registry: AgentsLike | undefined
  private account: StoredAccount | undefined
  private run: Channel | undefined
  private starting = false
  private readonly login: LoginSession

  constructor(ctx: Context, config: ConfigShape, dataDir: string) {
    this.ctx = ctx
    this.config = config
    this.dataDir = dataDir
    this.report = (line, detail) => {
      const logger = ctx.logger(name)
      if (detail === undefined) logger.info(line)
      else logger.warn(`${line} ${JSON.stringify(detail)}`)
    }
    this.store = new PersonaStore(join(dataDir, 'personas'))
    this.login = new LoginSession({
      api: createApiClient({ channelVersion: CHANNEL_VERSION, botAgent: 'wechat-persona' }),
      renderQr: renderQrSvg,
      onConnected: async credentials => { await this.connect(credentials) },
      report: this.report,
    })
  }

  /** 宿主 agents 服务到位后调用：恢复账号并开跑。 */
  async attach(registry: AgentsLike): Promise<void> {
    this.registry = registry
    this.account = await loadAccount(this.dataDir)
    if (this.account !== undefined) await this.startRun()
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

  /** 人格卡概览。 */
  async personas(): Promise<PersonaSummary[]> {
    const snapshot = await this.store.snapshot()
    return [...snapshot.personas.values()].map(persona => ({
      id: persona.card.id,
      name: persona.card.name,
      description: persona.card.description,
      warnings: persona.warnings.map(warning => `${warning.path}: ${warning.message}`),
    }))
  }

  /** 面板的动作集合。 */
  panelHandlers(): {
    status: () => Promise<PanelStatus>
    begin: () => Promise<ReturnType<LoginSession['view']>>
    poll: () => Promise<ReturnType<LoginSession['view']>>
    verifyCode: (code: string) => Promise<ReturnType<LoginSession['view']>>
    logout: () => Promise<ReturnType<LoginSession['view']>>
    personas: () => Promise<PersonaSummary[]>
  } {
    return {
      status: async () => await this.status(),
      begin: async () => await this.login.begin(),
      poll: async () => await this.login.poll(),
      verifyCode: code => Promise.resolve(this.login.submitVerifyCode(code)).then(() => this.login.poll()),
      logout: async () => { await this.logout(); return this.login.view() },
      personas: async () => await this.personas(),
    }
  }

  private async startRun(): Promise<void> {
    if (this.registry === undefined || this.account === undefined || this.starting) return
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

      const sessions = new PeerSessions({
        registry,
        cwd: this.config.cwd.get(),
        sessionOptions: this.modelSelection(),
        sessionExists: async id => await this.sessionExists(id),
        onError: error => { this.report('会话释放失败', { error: String(error) }) },
      })
      const api = createApiClient({ channelVersion: CHANNEL_VERSION, botAgent: 'wechat-persona' })
      const replies = new ReplyQueue({
        send: async (peerId, text, contextToken) => {
          await api.sendText({
            baseUrl: account.baseUrl,
            endpoint: 'ilink/bot/sendmessage',
            label: 'sendmessage',
            token: account.botToken,
            to: peerId,
            text,
            ...(contextToken === undefined ? {} : { contextToken }),
          })
        },
        onGiveUp: (peerId, text, error) => { this.report('回复最终失败', { peerId, chars: text.length, error: String(error) }) },
        maxChars: 2_000,
        minIntervalMs: 2_000,
      })

      const channel = new Channel({
        api,
        account: { baseUrl: account.baseUrl, token: account.botToken, userId: account.userId },
        sessions,
        access,
        personas: this.store,
        defaultPersona: this.config.defaultPersona.get(),
        replies,
        events: this.ctx as never,
        report: this.report,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      const cursor = await this.readCursor(account.accountId)
      this.run = channel
      this.report(`开始轮询（账号 ${account.accountId}）`)

      // 不 await：循环跑到 stop 为止；失败要落日志而不是变成未处理的 rejection。
      void channel.run(cursor).catch((error: unknown) => { this.report('通道停止', { error: String(error) }) })

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

  private async stopRun(): Promise<void> {
    if (this.cursorTimer !== undefined) {
      clearInterval(this.cursorTimer)
      this.cursorTimer = undefined
    }
    const run = this.run
    this.run = undefined
    if (run !== undefined) await run.stop()
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
    await this.stopRun()
  }
}

/**
 * 插件入口。
 * @param ctx - cordis 上下文。
 * @param config - 已解析的配置。
 */
export function apply(ctx: Context, config: ConfigShape): void {
  try {
    boot(ctx, config)
  } catch (error) {
    // 插件出错不能拖垮整个 profile：装错了要能开机、能看见日志、能卸载。
    ctx.logger(name).error(`wechat-persona 启动失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 真正的启动逻辑；异常由 {@link apply} 兜住。 */
function boot(ctx: Context, config: ConfigShape): void {
  const cwd = config.cwd.get()
  if (!isAbsolute(cwd)) {
    throw new Error(`wechat-persona: cwd 必须是绝对路径，收到 ${JSON.stringify(cwd)}`)
  }
  const configured = config.dataDir.get()
  const dataDir = isAbsolute(configured) ? configured : resolve(cwd, configured)
  const coordinator = new Coordinator(ctx, config, dataDir)

  // 通道半边：等 agents 到位再恢复账号。用条件 inject，headless profile 也不会被 park。
  void ctx.inject(['agents'], injected => {
    const registry = injected.get('agents') as AgentsLike | undefined
    if (registry === undefined) return
    void coordinator.attach(registry).catch((error: unknown) => {
      injected.logger(name).warn(`恢复登录失败：${String(error)}`)
    })
    injected.effect(() => () => { void coordinator.dispose() })
  })

  // 面板半边：只有能提供浏览器路由的宿主才挂。
  void ctx.inject(['connection'], injected => {
    const connection = injected.get('connection') as ConnectionLike | undefined
    if (connection?.fetch === undefined) return
    const panel = createPanel(coordinator.panelHandlers())
    injected.effect(() => {
      const disposers = [
        connection.fetch.register({ path: PANEL_PATH, methods: ['GET'], requestBody: 'buffered', fetch: async () => panel.page() }),
        connection.fetch.register({ path: `${PANEL_PREFIX}/status`, methods: ['GET'], requestBody: 'buffered', fetch: async () => await panel.status() }),
        connection.fetch.register({ path: `${PANEL_PREFIX}/begin`, methods: ['POST'], requestBody: 'buffered', fetch: async () => await panel.begin() }),
        connection.fetch.register({ path: `${PANEL_PREFIX}/poll`, methods: ['POST'], requestBody: 'buffered', fetch: async () => await panel.poll() }),
        connection.fetch.register({ path: `${PANEL_PREFIX}/verify-code`, methods: ['POST'], requestBody: 'buffered', fetch: async (request: Request) => await panel.verifyCode(request) }),
        connection.fetch.register({ path: `${PANEL_PREFIX}/logout`, methods: ['POST'], requestBody: 'buffered', fetch: async () => await panel.logout() }),
        connection.fetch.register({ path: `${PANEL_PREFIX}/personas`, methods: ['GET'], requestBody: 'buffered', fetch: async () => await panel.personas() }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    })
    injected.logger(name).info(`配置页：${panelUrl(injected)}`)
  })
}

/**
 * 面板的绝对地址。
 *
 * 端口从 webserver 读：`--port 0` 会绑一个配置里没写过的端口。
 */
function panelUrl(ctx: Context): string {
  const server = ctx.get('webServer') as { port?: number; host?: string } | undefined
  if (server?.port === undefined) return PANEL_PATH
  const host = server.host === '0.0.0.0' ? '127.0.0.1' : (server.host ?? '127.0.0.1')
  return `http://${host}:${String(server.port)}${PANEL_PATH}`
}
