/**
 * 「对方正在输入」。
 *
 * 一个用户一次只需要一个 ticket，ticket 有效期很长（协议侧约 24 小时），
 * 所以按用户缓存，失败时失效重取。
 *
 * 它永远是锦上添花：任何一步失败都静默跳过，绝不因为它发不出消息。
 *
 * @module wechat-persona/wechat/typing
 */

import type { ApiClient } from '../ilink/api.ts'

export interface TypingOptions {
  api: ApiClient
  baseUrl: string
  token: string
  /** 诊断出口。 */
  report?: (line: string, detail?: unknown) => void
}

/** 一个用户的输入状态控制。 */
export class TypingIndicator {
  private readonly options: TypingOptions
  private readonly tickets = new Map<string, string>()

  constructor(options: TypingOptions) {
    this.options = options
  }

  /**
   * 取（或复用）ticket。
   * @param userId - 目标用户。
   * @param contextToken - 本轮的会话令牌。
   */
  private async ticket(userId: string, contextToken: string | undefined): Promise<string | undefined> {
    const cached = this.tickets.get(userId)
    if (cached !== undefined && cached !== '') return cached
    try {
      const ticket = await this.options.api.getConfig({
        baseUrl: this.options.baseUrl,
        endpoint: 'ilink/bot/getconfig',
        label: 'getconfig',
        token: this.options.token,
        userId,
        ...(contextToken === undefined ? {} : { contextToken }),
      })
      if (ticket === '') return undefined
      this.tickets.set(userId, ticket)
      return ticket
    } catch (error) {
      this.options.report?.('取 typing ticket 失败', { userId, error: String(error) })
      return undefined
    }
  }

  /**
   * 开始显示「正在输入」。
   * @returns 本次是否真的上报成功（调用方不依赖它）。
   */
  async start(userId: string, contextToken?: string): Promise<boolean> {
    const ticket = await this.ticket(userId, contextToken)
    if (ticket === undefined) return false
    return await this.send(userId, ticket, 1)
  }

  /** 取消「正在输入」。 */
  async stop(userId: string, contextToken?: string): Promise<void> {
    const ticket = this.tickets.get(userId)
    if (ticket === undefined) return
    const ok = await this.send(userId, ticket, 2)
    // 上报被拒说明 ticket 过期，丢掉下次重取。
    if (!ok) this.tickets.delete(userId)
    void contextToken
  }

  private async send(userId: string, ticket: string, status: number): Promise<boolean> {
    try {
      await this.options.api.sendTyping({
        baseUrl: this.options.baseUrl,
        endpoint: 'ilink/bot/sendtyping',
        label: 'sendtyping',
        token: this.options.token,
        userId,
        ticket,
        status,
      })
      return true
    } catch (error) {
      this.options.report?.('上报输入状态失败', { userId, status, error: String(error) })
      return false
    }
  }

  /** 丢掉缓存的 ticket（退出登录时）。 */
  clear(): void {
    this.tickets.clear()
  }
}
