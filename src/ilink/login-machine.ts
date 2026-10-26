/**
 * 扫码登录的状态机。
 *
 * 纯函数：输入当前状态 + 一次服务端状态，输出下一个状态和「调用方该做的那一件事」。
 * 轮询、打印、读验证码都留在调用方，所以迁移规则可以不起网络、不看时钟地验证。
 *
 * 状态名与含义来自 openclaw-weixin 的协议文档；迁移规则与刷新预算参考
 * dsh-channel-wechat 的 login-machine（MIT, Copyright (c) wang.x）。
 *
 * @module wechat-persona/ilink/login-machine
 */

/** 协议定义的八个扫码状态。 */
export type QrStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'scaned_but_redirect'
  | 'binded_redirect'

/** 一次状态查询的响应体。 */
export interface QrStatusResponse {
  status: QrStatus
  /** 确认后签发。 */
  bot_token?: string
  /** Bot 账号 id，后面存凭据的键。 */
  ilink_bot_id?: string
  /** 服务端要求的 API base URL。 */
  baseurl?: string
  /** 扫码用户的 id。 */
  ilink_user_id?: string
  /** `scaned_but_redirect` 时要去的新 host。 */
  redirect_host?: string
}

/** 确认登录后得到的凭据。 */
export interface LoginCredentials {
  botToken: string
  accountId: string
  baseUrl: string
  userId: string | undefined
}

/** 调用方在迁移后该做的事。 */
export type LoginEffect =
  | { kind: 'poll' }
  | { kind: 'announce-scanned' }
  | { kind: 'request-verify-code'; retry: boolean }
  | { kind: 'refresh-qr' }
  | { kind: 'connected'; credentials: LoginCredentials }
  | { kind: 'already-connected' }
  | { kind: 'failed'; message: string }

/** 机器在两次轮询之间记住的全部东西。 */
export interface LoginState {
  /** 当前二维码值，每次轮询回传。 */
  qrcode: string
  /** 二维码里编码的 URL，展示给人。 */
  qrcodeUrl: string
  /** 下一次轮询去的 base URL；IDC 重定向时会变。 */
  apiBaseUrl: string
  /** 已签发过几个二维码（含第一个）。 */
  refreshCount: number
  /** 这个码是否已经提示过「已扫码」。 */
  scannedAnnounced: boolean
  /** 已输入但还没被接受的验证码，每次轮询重发。 */
  pendingVerifyCode?: string
}

export interface LoginTransition {
  state: LoginState
  effect: LoginEffect
}

/** 一个登录最多消耗几张二维码。 */
export const MAX_QR_REFRESH_COUNT = 3

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

/**
 * 起始状态。
 * @param apiBaseUrl - 首次请求用的 base URL。
 */
export function initialState(apiBaseUrl: string = DEFAULT_BASE_URL): LoginState {
  return { qrcode: '', qrcodeUrl: '', apiBaseUrl, refreshCount: 0, scannedAnnounced: false }
}

/** 把用户输入的验证码塞进状态。 */
export function withVerifyCode(state: LoginState, code: string): LoginState {
  return { ...state, pendingVerifyCode: code.trim() }
}

/** 应用一张新二维码。 */
export function withRefreshedQr(state: LoginState, qr: { qrcode: string; qrcodeUrl: string }): LoginState {
  return {
    ...state,
    qrcode: qr.qrcode,
    qrcodeUrl: qr.qrcodeUrl,
    scannedAnnounced: false,
    refreshCount: state.refreshCount + 1,
    pendingVerifyCode: undefined,
  }
}

/** 首次拿到二维码（还不算刷新）。 */
export function withInitialQr(state: LoginState, qr: { qrcode: string; qrcodeUrl: string }): LoginState {
  return { ...state, qrcode: qr.qrcode, qrcodeUrl: qr.qrcodeUrl }
}

function hostOf(baseUrl: string, fallback: string): string {
  try {
    return new URL(`https://${baseUrl}`).host
  } catch {
    return fallback
  }
}

/**
 * 推进一次。
 *
 * `refresh-qr` 是请求不是结果：调用方拿到新码后要调 {@link withRefreshedQr}，
 * 那一步才消耗刷新预算。在此之前状态保留旧码，所以忽略这个 effect 不会偷偷轮询死码。
 *
 * @param state - 上一次轮询留下的状态。
 * @param response - 服务端刚报的状态。
 */
export function advance(state: LoginState, response: QrStatusResponse): LoginTransition {
  switch (response.status) {
    case 'wait':
      return { state, effect: { kind: 'poll' } }

    case 'scaned':
      if (state.scannedAnnounced) return { state, effect: { kind: 'poll' } }
      return { state: { ...state, scannedAnnounced: true }, effect: { kind: 'announce-scanned' } }

    case 'confirmed': {
      // 缺任一必需字段都算失败：拿半个凭据去轮询只会得到含糊的错误。
      if (typeof response.bot_token !== 'string' || response.bot_token === '') {
        return { state, effect: { kind: 'failed', message: '已确认登录，但服务端没有返回 bot_token' } }
      }
      if (typeof response.ilink_bot_id !== 'string' || response.ilink_bot_id === '') {
        return { state, effect: { kind: 'failed', message: '已确认登录，但服务端没有返回 bot id' } }
      }
      return {
        state,
        effect: {
          kind: 'connected',
          credentials: {
            botToken: response.bot_token,
            accountId: response.ilink_bot_id,
            baseUrl: response.baseurl !== undefined && response.baseurl !== '' ? response.baseurl : state.apiBaseUrl,
            userId: response.ilink_user_id,
          },
        },
      }
    }

    case 'need_verifycode':
      return { state, effect: { kind: 'request-verify-code', retry: state.pendingVerifyCode !== undefined } }

    case 'verify_code_blocked':
      return { state, effect: { kind: 'failed', message: '验证码错误次数过多，请重新登录' } }

    case 'expired': {
      const used = state.refreshCount
      if (used >= MAX_QR_REFRESH_COUNT) {
        return { state, effect: { kind: 'failed', message: `二维码已过期，且已刷新 ${String(used)} 次` } }
      }
      return { state, effect: { kind: 'refresh-qr' } }
    }

    case 'scaned_but_redirect': {
      // 只换 host，沿用当前状态；下一步仍在 poll。
      if (typeof response.redirect_host !== 'string' || response.redirect_host === '') {
        return { state, effect: { kind: 'failed', message: '服务端要求重定向，但没有给出 redirect_host' } }
      }
      const host = hostOf(response.redirect_host, response.redirect_host)
      return { state: { ...state, apiBaseUrl: `https://${host}` }, effect: { kind: 'poll' } }
    }

    case 'binded_redirect':
      return { state, effect: { kind: 'already-connected' } }

    default:
      // 未知状态不猜：报出来比一直轮询一个看不懂的状态好。
      return { state, effect: { kind: 'failed', message: `未知的扫码状态：${String((response as { status?: unknown }).status)}` } }
  }
}
