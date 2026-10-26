/**
 * 发一张图片（含表情）。
 *
 * 顺序是固定的，每一步失败都会让后一步没有意义：
 *   MD5/尺寸 → getuploadurl → 加密上传（成功以 `x-encrypted-param` 头为准）→ sendmessage
 *
 * 上传语义参考 @tencent-weixin/openclaw-weixin (MIT, Copyright (C) 2026 Tencent)
 * 的 `cdn/cdn-upload.ts`；上传这一段已抽到 `upload.ts`，与文件发送共用。
 *
 * @module wechat-persona/ilink/send-image
 */

import type { ApiClient } from './api.ts'
import { UPLOAD_MAX_ATTEMPTS, aesEcbPaddedSize, uploadMedia } from './upload.ts'

export { UPLOAD_MAX_ATTEMPTS, aesEcbPaddedSize }

export interface SendImageOptions {
  api: ApiClient
  baseUrl: string
  token: string
  to: string
  contextToken?: string
  /** 明文图片字节。 */
  data: Uint8Array
  cdnBaseUrl?: string
  fetchImpl?: typeof fetch
  /** CDN 上的对象名；默认随机。 */
  filekey?: string
}

/**
 * 上传并发送一张图片。
 * @param options - 目标、明文与传输层。
 * @throws 任一步失败时抛错，调用方据此降级成文字。
 */
export async function sendImage(options: SendImageOptions): Promise<void> {
  const uploaded = await uploadMedia({
    api: options.api,
    baseUrl: options.baseUrl,
    token: options.token,
    to: options.to,
    data: options.data,
    mediaType: 1,
    ...(options.cdnBaseUrl === undefined ? {} : { cdnBaseUrl: options.cdnBaseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.filekey === undefined ? {} : { filekey: options.filekey }),
  })

  await options.api.sendImage({
    baseUrl: options.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    label: 'sendmessage(image)',
    token: options.token,
    to: options.to,
    encryptQueryParam: uploaded.downloadParam,
    // 图片的 key 用「16 字节原样」的 base64（文件是 hex 字符串的 base64，两者不同）。
    aesKeyBase64: uploaded.key.toString('base64'),
    ciphertextSize: uploaded.ciphertextSize,
    ...(options.contextToken === undefined ? {} : { contextToken: options.contextToken }),
  })
}
