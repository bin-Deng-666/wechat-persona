/**
 * 连通性探针：取一张登录二维码并查一次状态，然后丢弃。
 *
 * 用来在不启动 DSH、不扫码的前提下验证：请求头、`bot_type`、端点、响应解析是否还对。
 * 它不写任何凭据，二维码会在几分钟后自然过期。
 *
 *   node --experimental-strip-types scripts/probe-login.ts
 */

import { createApiClient } from '../src/ilink/api.ts'
import { fetchQr, pollStatus } from '../src/ilink/login.ts'
import { initialState, withInitialQr } from '../src/ilink/login-machine.ts'

const api = createApiClient({ channelVersion: '0.1.0', botAgent: 'wechat-persona' })

try {
  const qr = await fetchQr(api)
  console.log('取码成功：qrcode 长度', qr.qrcode.length)
  console.log('二维码内容：', qr.qrcodeUrl)

  const state = withInitialQr(initialState(), { qrcode: qr.qrcode, qrcodeUrl: qr.qrcodeUrl })
  const status = await pollStatus(api, state)
  console.log('状态查询成功：', status.status)
} catch (error) {
  console.error('探针失败：', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
