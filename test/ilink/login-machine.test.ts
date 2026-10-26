/** iLink 登录状态机。 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  advance,
  initialState,
  MAX_QR_REFRESH_COUNT,
  withInitialQr,
  withRefreshedQr,
  withVerifyCode,
  type LoginState,
} from '../../src/ilink/login-machine.ts'

describe('登录状态机', () => {
  const base: LoginState = withInitialQr(initialState(), { qrcode: 'q1', qrcodeUrl: 'https://qr/1' })

  it('wait → poll', () => {
    assert.deepEqual(advance(base, { status: 'wait' }).effect, { kind: 'poll' })
  })

  it('scaned 只提示一次', () => {
    const first = advance(base, { status: 'scaned' })
    assert.deepEqual(first.effect, { kind: 'announce-scanned' })
    const second = advance(first.state, { status: 'scaned' })
    assert.deepEqual(second.effect, { kind: 'poll' })
  })

  it('confirmed 返回完整凭据', () => {
    const { effect } = advance(base, {
      status: 'confirmed',
      bot_token: 'tok',
      ilink_bot_id: 'bot-1',
      baseurl: 'https://api2/',
      ilink_user_id: 'u-1',
    })
    assert.equal(effect.kind, 'connected')
    if (effect.kind !== 'connected') return
    assert.deepEqual(effect.credentials, { botToken: 'tok', accountId: 'bot-1', baseUrl: 'https://api2/', userId: 'u-1' })
  })

  it('confirmed 缺 bot_token 判失败', () => {
    const { effect } = advance(base, { status: 'confirmed', ilink_bot_id: 'bot-1' })
    assert.equal(effect.kind, 'failed')
  })

  it('need_verifycode 首次不标 retry，输入过之后标 retry', () => {
    assert.deepEqual(advance(base, { status: 'need_verifycode' }).effect, { kind: 'request-verify-code', retry: false })
    const withCode = withVerifyCode(base, '123456')
    assert.deepEqual(advance(withCode, { status: 'need_verifycode' }).effect, { kind: 'request-verify-code', retry: true })
  })

  it('expired 未超预算时要求刷新，超预算判失败', () => {
    assert.deepEqual(advance(base, { status: 'expired' }).effect, { kind: 'refresh-qr' })
    const exhausted: LoginState = { ...base, refreshCount: MAX_QR_REFRESH_COUNT }
    assert.equal(advance(exhausted, { status: 'expired' }).effect.kind, 'failed')
  })

  it('刷新二维码后计数 +1 且清掉验证码', () => {
    const withCode = withVerifyCode(base, '123')
    const refreshed = withRefreshedQr(withCode, { qrcode: 'q2', qrcodeUrl: 'https://qr/2' })
    assert.equal(refreshed.refreshCount, 1)
    assert.equal(refreshed.qrcode, 'q2')
    assert.equal(refreshed.pendingVerifyCode, undefined)
    assert.equal(refreshed.scannedAnnounced, false)
  })

  it('scaned_but_redirect 只换 host', () => {
    const { state, effect } = advance(base, { status: 'scaned_but_redirect', redirect_host: 'other.example.com' })
    assert.equal(state.apiBaseUrl, 'https://other.example.com')
    assert.deepEqual(effect, { kind: 'poll' })
  })

  it('binded_redirect 视为已连接', () => {
    assert.equal(advance(base, { status: 'binded_redirect' }).effect.kind, 'already-connected')
  })

  it('未知状态判失败而不是死循环', () => {
    assert.equal(advance(base, { status: 'weird' as never }).effect.kind, 'failed')
  })
})
