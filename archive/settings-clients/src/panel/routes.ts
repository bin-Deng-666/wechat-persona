/** 网页设置的输入校验与业务动作。HTTP 认证和联系人权限由入口层负责。 */

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
  maxChars?: number
  split?: 'paragraph' | 'sentence' | 'none'
}

export interface ChatPatch {
  peerId: string
  personaId?: string
  enabled?: boolean
  maxChars?: number | null
  split?: 'paragraph' | 'sentence' | 'none' | null
}

/** 一条记忆，供面板展示与编辑。 */
export interface MemoryEntry {
  id: string
  version: number
  title: string
  content: string
  type: string
  scope: string
  certainty: string
  tags: string[]
  createdAt: string
  updatedAt: string
  /** 原话来源；编辑时不动它。 */
  sources: { quote: string; timestamp: string; entryId: string }[]
}

/** 面板提交的一条记忆内容。 */
export interface MemoryInput {
  peerId: string
  /** 缺省表示新增。 */
  id?: string
  version?: number
  title: string
  content: string
  type: string
  scope: string
  certainty: string
  tags: string[]
}

/** 一张表情素材，供面板展示与编辑。 */
export interface StickerEntry {
  id: string
  status: 'pending' | 'ready' | 'ignored'
  name?: string
  description?: string
  scenes?: string
  mediaType: string
  bytes: number
  lastReceivedAt: string
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
  setChat: (patch: ChatPatch) => Promise<ChatSummary>
  control?: (peerId: string, action: 'new' | 'stop' | 'compact') => Promise<{ ok: boolean; message: string }>
  /** 一个联系人的记忆，包含旧版无来源资料。 */
  memory: (peerId: string) => Promise<{ memories: MemoryEntry[]; legacy: string[] }>
  /** 新增或修改一条记忆；带版本检查，冲突不落盘。 */
  saveMemory: (input: MemoryInput) => Promise<{ ok: boolean; issues: string[] }>
  /** 删除一条记忆（会留下删除记录，避免自动重建）。 */
  deleteMemory: (input: { peerId: string; id: string; version: number }) => Promise<{ ok: boolean; issues: string[] }>
  /** 清空一个联系人的记忆。 */
  clearMemory: (peerId: string) => Promise<{ ok: boolean }>
  /** 一个联系人的表情目录与人工共享表情。 */
  stickers: (peerId: string) => Promise<{ images: StickerEntry[]; shared: { name: string }[] }>
  /** 读一张素材原件，供面板预览。 */
  stickerImage: (input: { peerId: string; id: string }) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 改一张素材的名字/描述/场景/状态。 */
  saveSticker: (input: { peerId: string; id: string; name?: string; description?: string; scenes?: string; status?: StickerEntry['status'] }) => Promise<{ ok: boolean; issues: string[] }>
  /** 从联系人目录移掉一张。 */
  forgetSticker: (input: { peerId: string; id: string }) => Promise<{ ok: boolean }>
  /** 把一张复制进共享表情，之后所有聊天可用。 */
  publishSticker: (input: { peerId: string; id: string; name: string }) => Promise<{ ok: boolean; issues: string[] }>
  /** 删掉一张人工共享表情。 */
  unpublishSticker: (name: string) => Promise<{ ok: boolean }>
}

export interface PanelStatus {
  /** 是否已登录。 */
  /** DSH 中的 bot 运行状态；设置服务本身可独立在线。 */
  botOnline?: boolean
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
    if (!timingSafeEqual(provided, key)) {
      return new Response('缺少或错误的访问密钥', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    }
    return await handler(request)
  }
}

/** 常数时间比较，避免按字符逐位泄露。 */
export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return diff === 0
}

export interface PanelRoutes {
  access: () => Promise<Response>
  control: (request: Request) => Promise<Response>
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
  memory: (request: Request) => Promise<Response>
  saveMemory: (request: Request) => Promise<Response>
  deleteMemory: (request: Request) => Promise<Response>
  clearMemory: (request: Request) => Promise<Response>
  stickers: (request: Request) => Promise<Response>
  stickerImage: (request: Request) => Promise<Response>
  saveSticker: (request: Request) => Promise<Response>
  forgetSticker: (request: Request) => Promise<Response>
  publishSticker: (request: Request) => Promise<Response>
  unpublishSticker: (request: Request) => Promise<Response>
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
export function createPanel(handlers: PanelHandlers, prefix = PUBLIC_PREFIX, admin = true): PanelRoutes {
  return {
    access: async () => json({ admin }),
    control: async request => {
      const body = await readJson(request)
      const peerId = text(body?.['peerId']).trim()
      const action = body?.['action']
      if (!peerId || !['new', 'stop', 'compact'].includes(String(action))) return json({ error: '缺少联系人或操作不合法' }, 400)
      if (!handlers.control) return json({ error: '通道暂时不可用' }, 503)
      return json(await handlers.control(peerId, action as 'new' | 'stop' | 'compact'))
    },
    page: () => new Response(renderPage(prefix), {
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
      const body = await readJson(request)
      if (body === undefined) return json({ error: '请求体必须是 JSON 对象' }, 400)
      const peerId = typeof body['peerId'] === 'string' ? body['peerId'].trim() : ''
      if (peerId === '' || peerId.length > 256 || /[\u0000-\u001f]/u.test(peerId)) return json({ error: 'peerId 不合法' }, 400)
      const patch: ChatPatch = { peerId }
      if ('personaId' in body) {
        if (typeof body['personaId'] !== 'string' || !/^(?:[a-z0-9-]{1,32})?$/u.test(body['personaId'])) return json({ error: '人格 id 不合法' }, 400)
        patch.personaId = body['personaId']
      }
      if ('enabled' in body) {
        if (typeof body['enabled'] !== 'boolean') return json({ error: '回复开关不合法' }, 400)
        patch.enabled = body['enabled']
      }
      if ('maxChars' in body) {
        const chars = body['maxChars']
        if (chars !== null && (typeof chars !== 'number' || !Number.isInteger(chars) || chars < 20 || chars > 4096)) return json({ error: '每条字数应为 20–4096 的整数' }, 400)
        patch.maxChars = chars as number | null
      }
      if ('split' in body) {
        if (body['split'] !== null && !['paragraph', 'sentence', 'none'].includes(String(body['split']))) return json({ error: '分条方式不合法' }, 400)
        patch.split = body['split'] as ChatPatch['split']
      }
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
    memory: async request => {
      const peerId = readPeer(request)
      if (peerId === undefined) return json({ error: '缺少 peerId' }, 400)
      return json(await handlers.memory(peerId))
    },
    saveMemory: async request => {
      const body = await readJson(request)
      if (body === undefined) return json({ error: '请求体必须是 JSON' }, 400)
      const peerId = text(body['peerId']).trim()
      if (peerId === '') return json({ error: '缺少 peerId' }, 400)
      const input: MemoryInput = {
        peerId,
        title: text(body['title']),
        content: text(body['content']),
        type: text(body['type']),
        scope: text(body['scope']),
        certainty: text(body['certainty']) === '' ? '明确' : text(body['certainty']),
        tags: Array.isArray(body['tags']) ? body['tags'].filter((tag): tag is string => typeof tag === 'string') : [],
      }
      const id = text(body['id']).trim()
      if (id !== '') {
        const version = body['version']
        if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
          return json({ error: '修改一条记忆需要正确的 version' }, 400)
        }
        input.id = id
        input.version = version
      }
      const result = await handlers.saveMemory(input)
      return json(result, result.ok ? 200 : 422)
    },
    deleteMemory: async request => {
      const body = await readJson(request)
      if (body === undefined) return json({ error: '请求体必须是 JSON' }, 400)
      const peerId = text(body['peerId']).trim()
      const id = text(body['id']).trim()
      const version = body['version']
      if (peerId === '' || id === '') return json({ error: '缺少 peerId 或 id' }, 400)
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        return json({ error: '删除一条记忆需要正确的 version' }, 400)
      }
      const result = await handlers.deleteMemory({ peerId, id, version })
      return json(result, result.ok ? 200 : 422)
    },
    clearMemory: async request => {
      const peerId = readPeer(request)
      if (peerId === undefined) return json({ error: '缺少 peerId' }, 400)
      return json(await handlers.clearMemory(peerId))
    },
    stickers: async request => {
      const peerId = readPeer(request)
      if (peerId === undefined) return json({ error: '缺少 peerId' }, 400)
      return json(await handlers.stickers(peerId))
    },
    stickerImage: async request => {
      const peerId = readPeer(request)
      const id = new URL(request.url).searchParams.get('id') ?? ''
      if (peerId === undefined || id === '') return json({ error: '缺少 peerId 或 id' }, 400)
      const found = await handlers.stickerImage({ peerId, id })
      if (found === undefined) return new Response('没有这张素材', { status: 404 })
      return new Response(found.data as unknown as BodyInit, {
        status: 200,
        headers: { 'Content-Type': found.mediaType, 'Cache-Control': 'no-store' },
      })
    },
    saveSticker: async request => {
      const body = await readJson(request)
      if (body === undefined) return json({ error: '请求体必须是 JSON' }, 400)
      const peerId = text(body['peerId']).trim()
      const id = text(body['id']).trim()
      if (peerId === '' || id === '') return json({ error: '缺少 peerId 或 id' }, 400)
      const status = text(body['status'])
      const patch: { peerId: string; id: string; name?: string; description?: string; scenes?: string; status?: StickerEntry['status'] } = { peerId, id }
      if (typeof body['name'] === 'string') patch.name = body['name']
      if (typeof body['description'] === 'string') patch.description = body['description']
      if (typeof body['scenes'] === 'string') patch.scenes = body['scenes']
      if (status === 'pending' || status === 'ready' || status === 'ignored') patch.status = status
      const result = await handlers.saveSticker(patch)
      return json(result, result.ok ? 200 : 422)
    },
    forgetSticker: async request => {
      const body = await readJson(request)
      if (body === undefined) return json({ error: '请求体必须是 JSON' }, 400)
      const peerId = text(body['peerId']).trim()
      const id = text(body['id']).trim()
      if (peerId === '' || id === '') return json({ error: '缺少 peerId 或 id' }, 400)
      return json(await handlers.forgetSticker({ peerId, id }))
    },
    publishSticker: async request => {
      const body = await readJson(request)
      if (body === undefined) return json({ error: '请求体必须是 JSON' }, 400)
      const peerId = text(body['peerId']).trim()
      const id = text(body['id']).trim()
      const name = text(body['name']).trim()
      if (peerId === '' || id === '' || name === '') return json({ error: '缺少 peerId、id 或 name' }, 400)
      const result = await handlers.publishSticker({ peerId, id, name })
      return json(result, result.ok ? 200 : 422)
    },
    unpublishSticker: async request => {
      const body = await readJson(request)
      if (body === undefined) return json({ error: '请求体必须是 JSON' }, 400)
      const name = text(body['name']).trim()
      if (name === '') return json({ error: '缺少 name' }, 400)
      return json(await handlers.unpublishSticker(name))
    },
  }
}

/** 读 query 里的 peerId；空或带控制字符时当作非法。 */
function readPeer(request: Request): string | undefined {
  const peerId = new URL(request.url).searchParams.get('peerId') ?? ''
  return peerId !== '' && peerId.length <= 256 && !/[\u0000-\u001f]/u.test(peerId) ? peerId : undefined
}

/** 读 JSON 对象请求体；不是对象时返回 undefined。 */
async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body = (await request.json()) as unknown
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** 取字符串字段；非字符串当空串。 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
