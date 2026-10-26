/**
 * iLink 线上接口的薄封装。
 *
 * 刻意不依赖 DSH：`fetch`、版本号、bot agent 都是入参，所以同一份代码能在插件宿主、
 * CLI、单测里跑。错误分类（`BusinessError` / `classifyFetchError`）是回复队列判定
 * 「限流」与「拒绝」的依据。
 *
 * 请求头、字段名与判别式来自腾讯 openclaw-weixin 的协议文档；
 * 错误分类与重试语义参考 dsh-channel-wechat（MIT, Copyright (c) wang.x）。
 * 见 NOTICE.md。
 *
 * @module wechat-persona/ilink/api
 */

import { randomUUID } from 'node:crypto'

import type { GetUpdatesResult, WeixinMessage } from './types.ts'

/** 本通道声明的 app id。 */
export const ILINK_APP_ID = 'bot'

/** 协议里表示「被限流」的返回码。 */
export const RET_THROTTLED = -2

/** 协议里表示「会话已失效，需要重新扫码」的错误码。 */
export const ERRCODE_SESSION_EXPIRED = -14

/** 传输失败分类，用于日志（脱敏后仍能定位）。 */
export interface FetchErrorClassification {
  type: 'dns' | 'tcp' | 'tls' | 'timeout' | 'unknown'
  description: string
  code?: string
}

/**
 * 服务端在 HTTP 200 里返回的业务错误。
 *
 * `code` 是公开字段：回复队列要靠它区分限流与拒绝，而不必反过来依赖协议层。
 */
export class BusinessError extends Error {
  readonly code: number

  constructor(label: string, code: number, message: string) {
    super(`${label}: ${String(code)}${message === '' ? '' : ` ${message}`}`)
    this.name = 'BusinessError'
    this.code = code
  }
}

/** 非 2xx 的 HTTP 应答。 */
export class HttpStatusError extends Error {
  readonly status: number
  readonly body: string

  constructor(label: string, status: number, body: string) {
    super(`${label} ${String(status)}: ${body}`)
    this.name = 'HttpStatusError'
    this.status = status
    this.body = body
  }
}

/** 把 `1.2.3` 编成协议的 `0x00MMNNPP`。 */
export function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(part => {
    const value = Number.parseInt(part, 10)
    return Number.isNaN(value) ? 0 : value
  })
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

/**
 * 每次请求都带在 `base_info` 里的元数据。
 * @param options - 版本与 bot agent。
 */
export function buildBaseInfo(options: { channelVersion?: string; botAgent?: string } = {}): {
  channel_version: string
  bot_agent: string
} {
  const agent = options.botAgent?.trim() ?? ''
  return {
    channel_version: options.channelVersion ?? '0.0.0',
    bot_agent: agent === '' ? 'wechat-persona' : agent.slice(0, 256),
  }
}

/** 把传输层异常归成可读的一类。 */
export function classifyFetchError(error: unknown): FetchErrorClassification {
  if (error instanceof Error && error.name === 'AbortError') {
    return { type: 'timeout', description: '请求超时' }
  }
  const cause = (error as { cause?: unknown } | null | undefined)?.cause
  const code = (cause as { code?: unknown } | null | undefined)?.code
  const matchedCode = typeof code === 'string' ? code : undefined
  const withCode = matchedCode === undefined ? {} : { code: matchedCode }
  const text = `${String(cause ?? error ?? '')} ${matchedCode ?? ''}`

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/iu.test(text)) return { type: 'dns', description: 'DNS 解析失败', ...withCode }
  if (/ECONNREFUSED/iu.test(text)) return { type: 'tcp', description: '连接被拒绝', ...withCode }
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/iu.test(text)) return { type: 'tcp', description: '连接超时或不可达', ...withCode }
  if (/UND_ERR_SOCKET|SSL|TLS|CERT|UNABLE_TO_VERIFY|DEPTH_ZERO/iu.test(text)) return { type: 'tls', description: 'TLS 握手失败', ...withCode }
  return { type: 'unknown', description: '网络请求失败' }
}

export interface ApiClientOptions {
  /** 注入的传输层，默认全局 `fetch`。 */
  fetchImpl?: typeof fetch
  /** 本版本号，用于 `channel_version` 与 client-version 头。 */
  channelVersion?: string
  /** 观测用的 bot agent 字符串。 */
  botAgent?: string
}

export interface RequestOptions {
  /** Stable per logical delivery; reused across retries. */
  clientId?: string
  baseUrl: string
  /** 已编码的路径与查询串。 */
  endpoint: string
  timeoutMs?: number
  signal?: AbortSignal
  label: string
}

export interface GetUpdatesParams extends RequestOptions {
  token: string
  /** 上次返回的游标；首次为空。 */
  cursor?: string
}

export interface SendTextParams extends RequestOptions {
  token: string
  /** 目标用户 id。 */
  to: string
  text: string
  /** 本轮回传的会话令牌。 */
  contextToken?: string
}

export interface SendImageParams extends RequestOptions {
  token: string
  to: string
  /** CDN 返回的下载参数。 */
  encryptQueryParam: string
  /** AES key 的 base64（发送方声明）。 */
  aesKeyBase64: string
  /** 密文长度（服务端会核对）。 */
  ciphertextSize: number
  /** 本轮回传的会话令牌。 */
  contextToken?: string
}

export interface SendFileParams extends RequestOptions {
  token: string
  to: string
  /** CDN 返回的下载参数。 */
  encryptQueryParam: string
  /**
   * 出站 `media.aes_key`：先把 16 字节 key 写成 32 位 hex 字符串，再对**该字符串**做 base64。
   *
   * 图片、文件、视频统一这一种写法（腾讯 openclaw-weixin 与 dsh-channel-wechat 一致）。
   * 直接对 16 字节做 base64 会让收件人解不开密钥，微信侧表现为「图片已过期」。
   */
  aesKeyBase64: string
  /** 接收方看到的文件名。 */
  fileName: string
  /** 明文长度（十进制字符串，协议避免浮点）。 */
  plaintextSize: number
  /** 本轮回传的会话令牌。 */
  contextToken?: string
}

export interface GetUploadUrlParams extends RequestOptions {
  token: string
  /** CDN 上的对象名。 */
  filekey: string
  /** 1 图片 / 2 视频 / 3 文件 / 4 语音。 */
  mediaType: number
  to: string
  /** 明文长度。 */
  rawsize: number
  /** 明文 MD5（小写 hex）。 */
  rawfilemd5: string
  /** 补位后的密文长度，服务端会核对。 */
  filesize: number
  /** AES key 的小写 hex。 */
  aeskey: string
}

export interface GetUploadUrlResult {
  uploadParam: string | undefined
  uploadFullUrl: string | undefined
}

export interface GetConfigParams extends RequestOptions {
  token: string
  userId: string
  contextToken?: string
}

export interface SendTypingParams extends RequestOptions {
  token: string
  userId: string
  ticket: string
  /** 1 开始 / 2 取消。 */
  status: number
}

export interface ApiClient {
  /** 长轮询取消息。 */
  getUpdates(params: GetUpdatesParams): Promise<GetUpdatesResult>
  /** 发一条文本。 */
  sendText(params: SendTextParams): Promise<void>
  /** 发一张图片（图片需先上传到 CDN）。 */
  sendImage(params: SendImageParams): Promise<void>
  /** 发一个文件（文件需先上传到 CDN）。 */
  sendFile(params: SendFileParams): Promise<void>
  /** 申请一个上传地址与元数据。 */
  getUploadUrl(params: GetUploadUrlParams): Promise<GetUploadUrlResult>
  /** 取某个用户的 typing ticket（空串表示服务端没给）。 */
  getConfig(params: GetConfigParams): Promise<string>
  /** 上报输入状态。 */
  sendTyping(params: SendTypingParams): Promise<void>
  /** 未认证 GET（登录用）。 */
  get(params: RequestOptions): Promise<string>
  /** 可选认证的 JSON POST。 */
  post(params: RequestOptions & { body: string; token?: string }): Promise<string>
}

/** 一个随机 uint32 的十进制字符串再 base64。 */
function randomWechatUin(): string {
  return Buffer.from(String(Math.floor(Math.random() * 0x1_0000_0000)), 'utf8').toString('base64')
}

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

/**
 * 构造客户端。
 * @param options - 注入的传输层与请求元数据。
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const channelVersion = options.channelVersion ?? '0.0.0'
  const botAgent = options.botAgent
  const common: Record<string, string> = {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(buildClientVersion(channelVersion)),
  }

  /**
   * 发一个请求，超时与调用方 abort 都会中断它。
   *
   * 计时器 `unref`：被 hold 住的长轮询不能单独把进程吊住，
   * 否则关闭流程结束后它还多活 35 秒。
   */
  async function send(
    url: string,
    init: RequestInit,
    label: string,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const controller = timeoutMs !== undefined && timeoutMs > 0 ? new AbortController() : undefined
    const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs)
    timer?.unref()
    const forward = (): void => { controller?.abort() }
    if (controller !== undefined && signal !== undefined) {
      if (signal.aborted) forward()
      else signal.addEventListener('abort', forward, { once: true })
    }
    const requestSignal = controller?.signal ?? signal
    try {
      const response = await fetchImpl(url, requestSignal === undefined ? init : { ...init, signal: requestSignal })
      const text = await response.text()
      // 非 2xx 是服务端的判定而不是传输故障：保留状态码与 body，让调用方读协议错误。
      if (!response.ok) throw new HttpStatusError(label, response.status, text)
      return text
    } catch (error) {
      if (error instanceof HttpStatusError) throw error
      const classification = classifyFetchError(error)
      throw Object.assign(new Error(`${label}: ${classification.description}`), { classification, cause: error })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (controller !== undefined && signal !== undefined) signal.removeEventListener('abort', forward)
    }
  }

  const client: ApiClient = {
    async getUpdates(params) {
      const raw = await client.post({
        ...params,
        body: JSON.stringify({
          // 首次没有游标时发空串，协议就是这么写的。
          get_updates_buf: params.cursor ?? '',
          base_info: buildBaseInfo({ channelVersion, ...(botAgent === undefined ? {} : { botAgent }) }),
        }),
        endpoint: 'ilink/bot/getupdates',
        label: 'getupdates',
      })
      const parsed = JSON.parse(raw) as {
        ret?: number
        errcode?: number
        errmsg?: string
        msgs?: unknown[]
        get_updates_buf?: string
        longpolling_timeout_ms?: number
      }
      const code = parsed.errcode ?? parsed.ret
      if (typeof code === 'number' && code !== 0) {
        // 过期与限流必须能被上层区分，否则会「一直转圈」。
        throw new BusinessError('getupdates', code, parsed.errmsg ?? '')
      }
      return {
        msgs: parsed.msgs ?? [],
        get_updates_buf: typeof parsed.get_updates_buf === 'string' ? parsed.get_updates_buf : undefined,
        longpolling_timeout_ms: typeof parsed.longpolling_timeout_ms === 'number' ? parsed.longpolling_timeout_ms : undefined,
      }
    },

    async sendText(params) {
      const msg: Record<string, unknown> = {
        from_user_id: '',
        to_user_id: params.to,
        client_id: params.clientId ?? randomUUID(),
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: params.text } }],
      }
      // 有令牌就回传；没有就不编一个。
      if (params.contextToken !== undefined) msg['context_token'] = params.contextToken

      const raw = await client.post({
        ...params,
        body: JSON.stringify({
          msg,
          base_info: buildBaseInfo({ channelVersion, ...(botAgent === undefined ? {} : { botAgent }) }),
        }),
        endpoint: 'ilink/bot/sendmessage',
        label: 'sendmessage',
      })
      const parsed = JSON.parse(raw) as { ret?: number; errcode?: number; errmsg?: string }
      // HTTP 200 带错误码仍然是失败；`-14` 尤其致命。
      const code = parsed.errcode ?? parsed.ret
      if (typeof code === 'number' && code !== 0) throw new BusinessError('sendmessage', code, parsed.errmsg ?? '')
    },

    async getUploadUrl(params) {
      const raw = await client.post({
        ...params,
        body: JSON.stringify({
          filekey: params.filekey,
          media_type: params.mediaType,
          to_user_id: params.to,
          rawsize: params.rawsize,
          rawfilemd5: params.rawfilemd5,
          filesize: params.filesize,
          // 明确不要缩略图：要了却不传，服务端会等第二个对象。
          no_need_thumb: true,
          aeskey: params.aeskey,
          base_info: buildBaseInfo({ channelVersion, ...(botAgent === undefined ? {} : { botAgent }) }),
        }),
        endpoint: 'ilink/bot/getuploadurl',
        label: 'getuploadurl',
      })
      const parsed = JSON.parse(raw) as { upload_param?: string; upload_full_url?: string }
      return { uploadParam: parsed.upload_param, uploadFullUrl: parsed.upload_full_url }
    },

    async sendImage(params) {
      const msg: Record<string, unknown> = {
        from_user_id: '',
        to_user_id: params.to,
        client_id: params.clientId ?? randomUUID(),
        message_type: 2,
        message_state: 2,
        item_list: [{
          type: 2,
          image_item: {
            // aes_key 已在上传阶段按规范编码好；mid_size 是密文长度。
            media: {
              encrypt_query_param: params.encryptQueryParam,
              aes_key: params.aesKeyBase64,
              encrypt_type: 1,
            },
            mid_size: params.ciphertextSize,
          },
        }],
      }
      if (params.contextToken !== undefined) msg['context_token'] = params.contextToken

      const raw = await client.post({
        ...params,
        body: JSON.stringify({
          msg,
          base_info: buildBaseInfo({ channelVersion, ...(botAgent === undefined ? {} : { botAgent }) }),
        }),
        endpoint: 'ilink/bot/sendmessage',
        label: 'sendmessage(image)',
      })
      const parsed = JSON.parse(raw) as { ret?: number; errcode?: number; errmsg?: string }
      const code = parsed.errcode ?? parsed.ret
      if (typeof code === 'number' && code !== 0) throw new BusinessError('sendmessage(image)', code, parsed.errmsg ?? '')
    },

    async sendFile(params) {
      const msg: Record<string, unknown> = {
        from_user_id: '',
        to_user_id: params.to,
        client_id: params.clientId ?? randomUUID(),
        message_type: 2,
        message_state: 2,
        item_list: [{
          // 消息项里文件是 4（与 getuploadurl 的 media_type=3 是两套编号）。
          type: 4,
          file_item: {
            media: {
              encrypt_query_param: params.encryptQueryParam,
              aes_key: params.aesKeyBase64,
              encrypt_type: 1,
            },
            file_name: params.fileName,
            // 明文长度：服务端显示「12.3 KB」用这个，不是密文长度。
            len: String(params.plaintextSize),
          },
        }],
      }
      if (params.contextToken !== undefined) msg['context_token'] = params.contextToken

      const raw = await client.post({
        ...params,
        body: JSON.stringify({
          msg,
          base_info: buildBaseInfo({ channelVersion, ...(botAgent === undefined ? {} : { botAgent }) }),
        }),
        endpoint: 'ilink/bot/sendmessage',
        label: 'sendmessage(file)',
      })
      const parsed = JSON.parse(raw) as { ret?: number; errcode?: number; errmsg?: string }
      const code = parsed.errcode ?? parsed.ret
      if (typeof code === 'number' && code !== 0) throw new BusinessError('sendmessage(file)', code, parsed.errmsg ?? '')
    },

    async getConfig(params) {
      const raw = await client.post({
        ...params,
        body: JSON.stringify({
          ilink_user_id: params.userId,
          ...(params.contextToken === undefined ? {} : { context_token: params.contextToken }),
          base_info: buildBaseInfo({ channelVersion, ...(botAgent === undefined ? {} : { botAgent }) }),
        }),
        endpoint: 'ilink/bot/getconfig',
        label: 'getconfig',
      })
      const parsed = JSON.parse(raw) as { ret?: number; typing_ticket?: unknown }
      // 只有 ret === 0 才是票据；把拒绝时的文案缓存下来会污染状态上报。
      if (parsed.ret !== 0) return ''
      return typeof parsed.typing_ticket === 'string' ? parsed.typing_ticket : ''
    },

    async sendTyping(params) {
      const raw = await client.post({
        ...params,
        body: JSON.stringify({
          ilink_user_id: params.userId,
          typing_ticket: params.ticket,
          status: params.status,
          base_info: buildBaseInfo({ channelVersion, ...(botAgent === undefined ? {} : { botAgent }) }),
        }),
        endpoint: 'ilink/bot/sendtyping',
        label: 'sendtyping',
      })
      const parsed = JSON.parse(raw) as { ret?: number; errmsg?: string }
      // 拒绝要抛：这是「票据过期」唯一的证据，吞掉就只能靠猜。
      if (typeof parsed.ret === 'number' && parsed.ret !== 0) {
        throw new BusinessError('sendtyping', parsed.ret, parsed.errmsg ?? '')
      }
    },

    async get(params) {
      const url = new URL(params.endpoint, withTrailingSlash(params.baseUrl)).toString()
      return await send(url, { method: 'GET', headers: { ...common } }, params.label, params.timeoutMs, params.signal)
    },

    async post(params) {
      const url = new URL(params.endpoint, withTrailingSlash(params.baseUrl)).toString()
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': randomWechatUin(),
        ...common,
      }
      if (params.token !== undefined && params.token.trim() !== '') headers['Authorization'] = `Bearer ${params.token.trim()}`
      return await send(url, { method: 'POST', headers, body: params.body }, params.label, params.timeoutMs, params.signal)
    },
  }

  return client
}

/** 把一条原始 `msgs` 元素收窄成 {@link WeixinMessage}；形状不对返回 undefined。 */
export function asWeixinMessage(raw: unknown): WeixinMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const candidate = raw as WeixinMessage
  if (typeof candidate.from_user_id !== 'string' || candidate.from_user_id === '') return undefined
  return candidate
}
