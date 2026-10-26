/**
 * 浏览器配置页。
 *
 * 路由全部挂在 `/api/persona-wechat/*` 下：宿主的 token fence 覆盖 `/api`，
 * 注册在别处的路由任何本机进程都能访问。
 *
 * 页面刻意做成单文件（内联 HTML/CSS/JS）：这一版只解决「扫码登录 + 看到状态 + 管人格」，
 * 不引入客户端打包链路。等需要「按聊天改设置」时再升级成 bundle client。
 *
 * @module wechat-persona/panel/routes
 */

import { renderPage } from './page.ts'
import type { LoginView } from '../auth/session.ts'

/** 所有路由共用的前缀，也是它们被认证的原因。 */
export const PANEL_PREFIX = '/api/persona-wechat'

/** 页面路径（宿主 fenced 的 `/api` 下；桌面版 Electron 外部浏览器拿不到 cookie）。 */
export const PANEL_PATH = `${PANEL_PREFIX}/panel`

/**
 * 不依赖宿主 cookie 的独立入口。
 *
 * 桌面版的 GUI 跑在 Electron 里，普通浏览器没有它的 cookie，`/api` 一律 401。
 * 所以再开一条自己的路由：服务端只监听 127.0.0.1，入口靠启动时生成的随机密钥保护。
 */
export const PUBLIC_PREFIX = '/persona-wechat'

/** 独立入口的完整页面路径。 */
export const PUBLIC_PATH = `${PUBLIC_PREFIX}/panel`

/** 一个聊天的概览，供页面编辑。 */
export interface ChatSummary {
  peerId: string
  personaId?: string
  enabled: boolean
}

/** 面板需要的最小接口。 */
export interface PanelHandlers {
  /** 只读状态。 */
  status: () => Promise<PanelStatus>
  /** 开始一次登录。 */
  begin: () => Promise<LoginView>
  /** 轮询一次扫码状态。 */
  poll: () => Promise<LoginView>
  /** 提交验证码。 */
  verifyCode: (code: string) => Promise<LoginView>
  /** 退出登录。 */
  logout: () => Promise<LoginView>
  /** 人格卡概览。 */
  personas: () => Promise<PersonaSummary[]>
  /** 读一张人格卡的原始 JSON。 */
  readPersona: (id: string) => Promise<{ ok: boolean; raw?: string; error?: string }>
  /** 写一张人格卡；校验不过不落盘。 */
  writePersona: (id: string, raw: string) => Promise<{ ok: boolean; issues: string[]; warnings: string[] }>
  /** 已知聊天的设置。 */
  chats: () => Promise<ChatSummary[]>
  /** 更新一个聊天的设置。 */
  setChat: (patch: { peerId: string; personaId?: string; enabled?: boolean }) => Promise<ChatSummary>
}

export interface PanelStatus {
  /** 是否已登录。 */
  connected: boolean
  /** 登录的微信号（可能为空）。 */
  userId?: string
  /** 登录视图。 */
  login: LoginView
  /** 数据目录，显示给用户找他的人格卡。 */
  dataDir: string
}

export interface PersonaSummary {
  id: string
  name: string
  description: string
  /** 校验告警。 */
  warnings: string[]
}

/**
 * 用随机密钥保护一个处理器。
 *
 * @param handler - 真正的处理器。
 * @param key - 启动时生成的密钥。
 * @returns 密钥不符时返回 401 的处理器。
 */
export function withKey(
  handler: (request: Request) => Promise<Response> | Response,
  key: string,
): (request: Request) => Promise<Response> {
  return async request => {
    const provided = new URL(request.url).searchParams.get('key') ?? ''
    if (!timingSafeEqualString(provided, key)) {
      return new Response('缺少或错误的访问密钥', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    }
    return await handler(request)
  }
}

/** 常数时间比较，避免按字符逐位泄露。 */
function timingSafeEqualString(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return diff === 0
}

export interface PanelRoutes {
  page: () => Response
  status: () => Promise<Response>
  begin: () => Promise<Response>
  poll: () => Promise<Response>
  verifyCode: (request: Request) => Promise<Response>
  logout: () => Promise<Response>
  personas: () => Promise<Response>
  chats: () => Promise<Response>
  setChat: (request: Request) => Promise<Response>
  readPersona: (request: Request) => Promise<Response>
  writePersona: (request: Request) => Promise<Response>
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/**
 * 构造路由处理器。
 * @param handlers - 面板背后的真实动作。
 */
export function createPanel(handlers: PanelHandlers): PanelRoutes {
  return {
    page: () => new Response(renderPage(PUBLIC_PREFIX), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    }),
    status: async () => json(await handlers.status()),
    begin: async () => json(await handlers.begin()),
    poll: async () => json(await handlers.poll()),
    verifyCode: async request => {
      let code = ''
      try {
        const body = (await request.json()) as { code?: unknown }
        if (typeof body.code === 'string') code = body.code.trim()
      } catch {
        return json({ error: '请求体必须是 JSON：{"code":"123456"}' }, 400)
      }
      if (!/^\d{4,8}$/u.test(code)) return json({ error: '验证码应为 4-8 位数字' }, 400)
      return json(await handlers.verifyCode(code))
    },
    logout: async () => json(await handlers.logout()),
    personas: async () => json(await handlers.personas()),
    chats: async () => json(await handlers.chats()),
    setChat: async request => {
      let body: Record<string, unknown>
      try {
        body = (await request.json()) as Record<string, unknown>
      } catch {
        return json({ error: '请求体必须是 JSON' }, 400)
      }
      const peerId = typeof body['peerId'] === 'string' ? body['peerId'].trim() : ''
      if (peerId === '') return json({ error: '缺少 peerId' }, 400)
      const patch: { peerId: string; personaId?: string; enabled?: boolean } = { peerId }
      // 只接受明确给了的字段：undefined 表示「不改」，不是「清空」。
      if (typeof body['personaId'] === 'string') patch.personaId = body['personaId'].trim()
      if (typeof body['enabled'] === 'boolean') patch.enabled = body['enabled']
      return json(await handlers.setChat(patch))
    },
    readPersona: async request => {
      const id = new URL(request.url).searchParams.get('id') ?? ''
      if (!/^[a-z0-9-]{1,32}$/u.test(id)) return json({ error: 'id 不合法' }, 400)
      return json(await handlers.readPersona(id))
    },
    writePersona: async request => {
      let body: { id?: unknown; raw?: unknown }
      try {
        body = (await request.json()) as { id?: unknown; raw?: unknown }
      } catch {
        return json({ error: '请求体必须是 JSON' }, 400)
      }
      const id = typeof body.id === 'string' ? body.id : ''
      const raw = typeof body.raw === 'string' ? body.raw : ''
      if (!/^[a-z0-9-]{1,32}$/u.test(id)) return json({ error: 'id 不合法' }, 400)
      const result = await handlers.writePersona(id, raw)
      return json(result, result.ok ? 200 : 422)
    },
  }
}
