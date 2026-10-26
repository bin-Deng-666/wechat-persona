/**
 * 把登录状态机接到真实 IO 上：取码、轮询、验证码、成功落盘。
 *
 * 一个会话同时只允许一个登录在跑（页面会被打开两次，但服务只能有一个状态），
 * 所以这里是单例式的：`begin` 覆盖旧状态，`status` 只有在有状态时才轮询。
 *
 * @module wechat-persona/auth/session
 */

import type { ApiClient } from '../ilink/api.ts'
import { fetchQr, pollStatus, type QrCode } from '../ilink/login.ts'
import {
  advance,
  initialState,
  withInitialQr,
  withRefreshedQr,
  withVerifyCode,
  type LoginCredentials,
  type LoginEffect,
  type LoginState,
} from '../ilink/login-machine.ts'

export type LoginPhase = 'idle' | 'waiting' | 'scanned' | 'verify' | 'connected' | 'failed'

export interface LoginView {
  phase: LoginPhase
  /** 要展示的二维码；`verify` 阶段仍保留。 */
  qr?: { url: string; svg: string }
  /** 给用户看的一句话。 */
  message: string
  /** 已扫码但没确认时，页面可以提示「在手机上点确认」。 */
  accountId?: string
  /** 错误详情，诊断用。 */
  detail?: string
}

export interface LoginSessionOptions {
  api: ApiClient
  /** 渲染二维码为 SVG（宿主注入，便于测试替换）。 */
  renderQr: (url: string) => string
  /** 登录成功后落盘。 */
  onConnected: (credentials: LoginCredentials) => Promise<void>
  /** 诊断出口。 */
  report?: (line: string, detail?: unknown) => void
}

export class LoginSession {
  private readonly options: LoginSessionOptions
  private state: LoginState | undefined
  private phase: LoginPhase = 'idle'
  private message = '尚未开始'
  private detail: string | undefined
  private qr: QrCode | undefined

  constructor(options: LoginSessionOptions) {
    this.options = options
  }

  /** 当前视图，供页面轮询。 */
  view(): LoginView {
    return {
      phase: this.phase,
      ...(this.qr === undefined ? {} : { qr: { url: this.qr.qrcodeUrl, svg: this.options.renderQr(this.qr.qrcodeUrl) } }),
      message: this.message,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    }
  }

  /**
   * 开始（或重新开始）一次登录：取码并把状态机复位。
   */
  async begin(): Promise<LoginView> {
    try {
      const qr = await fetchQr(this.options.api)
      this.qr = qr
      this.state = withInitialQr(initialState(), { qrcode: qr.qrcode, qrcodeUrl: qr.qrcodeUrl })
      this.phase = 'waiting'
      this.message = '用手机微信扫描二维码'
      this.detail = undefined
    } catch (error) {
      this.fail('取二维码失败', error)
    }
    return this.view()
  }

  /** 用户输入验证码。 */
  submitVerifyCode(code: string): LoginView {
    if (this.state === undefined) return this.view()
    this.state = withVerifyCode(this.state, code)
    this.message = '正在校验验证码…'
    return this.view()
  }

  /**
   * 轮询一次状态并执行 effect。
   *
   * 页面每次刷新都调它；`wait`/`scaned` 阶段返回得快，`confirmed` 后落盘并停下来。
   */
  async poll(): Promise<LoginView> {
    if (this.state === undefined || this.phase === 'connected' || this.phase === 'failed') return this.view()

    let response
    try {
      response = await pollStatus(this.options.api, this.state)
    } catch (error) {
      // 单次轮询失败不算登录失败：网络抖动很常见，保持状态等下次。
      this.options.report?.('轮询扫码状态失败', { error: String(error) })
      return this.view()
    }

    const transition = advance(this.state, response)
    this.state = transition.state
    await this.apply(transition.effect)
    return this.view()
  }

  private async apply(effect: LoginEffect): Promise<void> {
    switch (effect.kind) {
      case 'poll':
        return
      case 'announce-scanned':
        this.phase = 'scanned'
        this.message = '已扫码，请在手机上确认登录'
        return
      case 'request-verify-code':
        this.phase = 'verify'
        this.message = effect.retry ? '验证码不对，请重新输入' : '请输入手机微信上显示的数字'
        return
      case 'refresh-qr': {
        const qr = await fetchQr(this.options.api)
        this.qr = qr
        if (this.state !== undefined) this.state = withRefreshedQr(this.state, { qrcode: qr.qrcode, qrcodeUrl: qr.qrcodeUrl })
        this.phase = 'waiting'
        this.message = '二维码已过期，已换一张'
        return
      }
      case 'connected':
        await this.options.onConnected(effect.credentials)
        this.phase = 'connected'
        this.message = '已连接'
        return
      case 'already-connected':
        this.phase = 'connected'
        this.message = '这个微信号已经绑定到另一个实例，无需重复登录'
        return
      case 'failed':
        this.phase = 'failed'
        this.message = effect.message
        return
    }
  }

  private fail(message: string, error: unknown): void {
    this.phase = 'failed'
    this.message = message
    this.detail = error instanceof Error ? error.message : String(error)
  }

  /** 会话被服务端判为失效（errcode -14）：停在可重新扫码的状态。 */
  markExpired(): void {
    this.phase = 'failed'
    this.message = '登录已失效，请重新取码扫码'
    this.qr = undefined
    this.state = undefined
  }

  /** 退出登录后复位。 */
  reset(): void {
    this.state = undefined
    this.qr = undefined
    this.phase = 'idle'
    this.message = '尚未开始'
    this.detail = undefined
  }
}
