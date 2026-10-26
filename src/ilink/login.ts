/**
 * 扫码登录的四个原语：取二维码、轮询状态、解析、以及把 effect 落成动作。
 *
 * 只做 HTTP 与解析，不做轮询循环——循环在宿主侧（CLI 或 GUI 面板），
 * 因为它们对「谁来扫码、验证码从哪读」的答案完全不同。
 *
 * 端点与字段名来自 openclaw-weixin 的协议文档；`qrcode_img_content` 是一段 HTML 页面
 * （不是图片），所以展示端必须自己把它渲染成二维码。
 *
 * @module wechat-persona/ilink/login
 */

import type { ApiClient } from './api.ts'
import type { LoginState, QrStatusResponse } from './login-machine.ts'

/** 登录相关请求固定打这个 base；确认后服务端会给出后续用的 baseurl。 */
export const LOGIN_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** 本构建声明的 `bot_type`。 */
export const QR_BOT_TYPE = '3'

/** 状态轮询允许服务端 hold 的时长。 */
export const POLL_TIMEOUT_MS = 40_000

/** 一次登录从取码到确认的总预算。 */
export const LOGIN_DEADLINE_MS = 5 * 60_000

export interface QrCode {
  /** 轮询时回传的值。 */
  qrcode: string
  /** 要编码成二维码的 URL。 */
  qrcodeUrl: string
}

/**
 * 解析 `get_bot_qrcode` 的响应。
 * @param raw - 响应文本。
 * @throws 缺 `qrcode` 或 `qrcode_img_content` 时抛错——半个二维码不可用。
 */
export function parseQrResponse(raw: string): QrCode {
  const parsed = JSON.parse(raw) as { qrcode?: unknown; qrcode_img_content?: unknown }
  if (typeof parsed.qrcode !== 'string' || parsed.qrcode === '') throw new Error('get_bot_qrcode 响应缺少 qrcode')
  if (typeof parsed.qrcode_img_content !== 'string') throw new Error('get_bot_qrcode 响应缺少 qrcode_img_content')
  return { qrcode: parsed.qrcode, qrcodeUrl: parsed.qrcode_img_content }
}

/**
 * 取一张新二维码。
 * @param api - 协议客户端。
 * @param botType - `bot_type` 查询参数。
 */
export async function fetchQr(api: ApiClient, botType: string = QR_BOT_TYPE): Promise<QrCode> {
  const raw = await api.post({
    baseUrl: LOGIN_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: JSON.stringify({ local_token_list: [] }),
    label: 'get_bot_qrcode',
  })
  return parseQrResponse(raw)
}

/**
 * 轮询一次扫码状态，带上待验证的验证码（如果有）。
 * @param api - 协议客户端。
 * @param state - 当前登录状态。
 */
export async function pollStatus(api: ApiClient, state: LoginState): Promise<QrStatusResponse> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(state.qrcode)}`
  if (state.pendingVerifyCode !== undefined && state.pendingVerifyCode !== '') {
    endpoint += `&verify_code=${encodeURIComponent(state.pendingVerifyCode)}`
  }
  const raw = await api.get({
    baseUrl: state.apiBaseUrl,
    endpoint,
    timeoutMs: POLL_TIMEOUT_MS,
    label: 'get_qrcode_status',
  })
  return JSON.parse(raw) as QrStatusResponse
}
