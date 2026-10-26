/** 将面板处理器注册到宿主；页面渲染和业务动作分别由 page/routes 与 Coordinator 管理。 */
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { name } from '../app/identity.ts'
import { createPanel, PANEL_PATH, PANEL_PREFIX, PUBLIC_PATH, PUBLIC_PREFIX, withKey, type PanelHandlers } from './routes.ts'

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

export function registerPanel(ctx: Context, handlers: PanelHandlers, announce: (url: string) => void): void {
  // 面板半边：只有能提供浏览器路由的宿主才挂。
  void ctx.inject(['connection'], injected => {
    const connection = injected.get('connection') as ConnectionLike | undefined
    if (connection?.fetch === undefined) return
    const panel = createPanel(handlers)
    // 独立入口的随机密钥：只在本进程生命周期内有效，重启即换。
    const publicKey = randomBytes(12).toString('base64url')
    const publicUrl = (ctx.get('webServer') as { port?: number } | undefined)?.port
    announce(
      publicUrl === undefined
        ? `${PUBLIC_PATH}?key=${publicKey}`
        : `http://127.0.0.1:${String(publicUrl)}${PUBLIC_PATH}?key=${publicKey}`,
    )

    injected.effect(() => {
      const disposers = [
        connection.fetch.register({ path: PANEL_PATH, methods: ['GET'], requestBody: 'buffered', fetch: async () => panel.page() }),
        connection.fetch.register({ path: `${PANEL_PREFIX}/status`, methods: ['GET'], requestBody: 'buffered', fetch: async () => await panel.status() }),
        connection.fetch.register({ path: `${PANEL_PREFIX}/begin`, methods: ['POST'], requestBody: 'buffered', fetch: async () => await panel.begin() }),
        connection.fetch.register({ path: `${PANEL_PREFIX}/poll`, methods: ['POST'], requestBody: 'buffered', fetch: async () => await panel.poll() }),
        connection.fetch.register({ path: `${PANEL_PREFIX}/verify-code`, methods: ['POST'], requestBody: 'buffered', fetch: async (request: Request) => await panel.verifyCode(request) }),
        connection.fetch.register({ path: `${PANEL_PREFIX}/logout`, methods: ['POST'], requestBody: 'buffered', fetch: async () => await panel.logout() }),
        connection.fetch.register({ path: `${PANEL_PREFIX}/personas`, methods: ['GET'], requestBody: 'buffered', fetch: async () => await panel.personas() }),
        connection.fetch.register({ path: `${PANEL_PREFIX}/chats`, methods: ['GET'], requestBody: 'buffered', fetch: async () => await panel.chats() }),
        connection.fetch.register({ path: `${PANEL_PREFIX}/chat`, methods: ['POST'], requestBody: 'buffered', fetch: async (request: Request) => await panel.setChat(request) }),
        connection.fetch.register({ path: `${PANEL_PREFIX}/persona`, methods: ['GET'], requestBody: 'buffered', fetch: async (request: Request) => await panel.readPersona(request) }),
        connection.fetch.register({ path: `${PANEL_PREFIX}/persona/save`, methods: ['POST'], requestBody: 'buffered', fetch: async (request: Request) => await panel.writePersona(request) }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    })

    // 不依赖宿主 cookie 的一套入口（桌面版必须的）：同一批处理器，外面套密钥校验。
    const publicRoutes: { path: string; methods: readonly string[]; run: (request: Request) => Promise<Response> }[] = [
      { path: `${PUBLIC_PREFIX}/panel`, methods: ['GET'], run: async () => panel.page() },
      { path: `${PUBLIC_PREFIX}/status`, methods: ['GET'], run: async () => await panel.status() },
      { path: `${PUBLIC_PREFIX}/begin`, methods: ['POST'], run: async () => await panel.begin() },
      { path: `${PUBLIC_PREFIX}/poll`, methods: ['POST'], run: async () => await panel.poll() },
      { path: `${PUBLIC_PREFIX}/verify-code`, methods: ['POST'], run: async (request: Request) => await panel.verifyCode(request) },
      { path: `${PUBLIC_PREFIX}/logout`, methods: ['POST'], run: async () => await panel.logout() },
      { path: `${PUBLIC_PREFIX}/personas`, methods: ['GET'], run: async () => await panel.personas() },
      { path: `${PUBLIC_PREFIX}/chats`, methods: ['GET'], run: async () => await panel.chats() },
      { path: `${PUBLIC_PREFIX}/chat`, methods: ['POST'], run: async (request: Request) => await panel.setChat(request) },
      { path: `${PUBLIC_PREFIX}/persona`, methods: ['GET'], run: async (request: Request) => await panel.readPersona(request) },
      { path: `${PUBLIC_PREFIX}/persona/save`, methods: ['POST'], run: async (request: Request) => await panel.writePersona(request) },
    ]
    injected.effect(() => {
      const disposers = publicRoutes.map(route =>
        connection.fetch.register({
          path: route.path,
          methods: route.methods,
          requestBody: 'buffered',
          fetch: withKey(route.run, publicKey),
        }))
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
