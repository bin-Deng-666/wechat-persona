/**
 * 发一张图片（含表情）。
 *
 * 顺序是固定的，每一步失败都会让后一步没有意义：
 *   MD5/尺寸 → getuploadurl → 加密上传（成功以 `x-encrypted-param` 头为准）→ sendmessage
 *
 * 上传成功但 200 没有那个头是最容易踩的坑：状态码看着正常，图片却永远取不到。
 *
 * 上传语义参考 @tencent-weixin/openclaw-weixin (MIT, Copyright (C) 2026 Tencent)
 * 的 `cdn/cdn-upload.ts`。
 *
 * @module wechat-persona/ilink/send-image
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'

import type { ApiClient } from './api.ts'
import { CDN_BASE_URL, encryptAesEcb } from './media.ts'

/** 传输层瞬时失败最多重试几次。 */
export const UPLOAD_MAX_ATTEMPTS = 3

const BLOCK_BYTES = 16

/** PKCS#7 补位后的密文长度（补位至少加一个字节）。 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / BLOCK_BYTES) * BLOCK_BYTES
}

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
 * @returns 实际使用的 AES key（诊断用，不含敏感信息）。
 * @throws 任一步失败时抛错，调用方据此降级成文字。
 */
export async function sendImage(options: SendImageOptions): Promise<void> {
  const key = randomBytes(BLOCK_BYTES)
  const plaintext = Buffer.from(options.data)
  const filekey = options.filekey ?? randomUUID()
  const cdnBaseUrl = options.cdnBaseUrl ?? CDN_BASE_URL
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const ciphertextSize = aesEcbPaddedSize(plaintext.length)

  const upload = await options.api.getUploadUrl({
    baseUrl: options.baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    label: 'getuploadurl',
    token: options.token,
    filekey,
    mediaType: 1,
    to: options.to,
    rawsize: plaintext.length,
    rawfilemd5: createHash('md5').update(plaintext).digest('hex'),
    filesize: ciphertextSize,
    aeskey: key.toString('hex'),
  })

  const target = upload.uploadFullUrl !== undefined && upload.uploadFullUrl.trim() !== ''
    ? upload.uploadFullUrl
    : upload.uploadParam === undefined
      ? undefined
      : `${cdnBaseUrl.endsWith('/') ? cdnBaseUrl.slice(0, -1) : cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(upload.uploadParam)}&filekey=${encodeURIComponent(filekey)}`
  if (target === undefined) throw new Error('getuploadurl 没有返回可用的上传地址')

  const ciphertext = encryptAesEcb(plaintext, key)
  let lastError: unknown
  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      })
      if (response.status >= 400 && response.status < 500) {
        // 被拒就是被拒，重试没有意义。
        throw new Error(`CDN 上传被拒绝 ${String(response.status)}`)
      }
      if (response.status !== 200) throw new Error(`CDN 上传失败 ${String(response.status)}`)
      const downloadParam = response.headers.get('x-encrypted-param')
      if (downloadParam === null || downloadParam === '') {
        throw new Error('CDN 上传返回 200 但没有 x-encrypted-param 头，图片取不到')
      }

      await options.api.sendImage({
        baseUrl: options.baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        label: 'sendmessage(image)',
        token: options.token,
        to: options.to,
        encryptQueryParam: downloadParam,
        aesKeyBase64: key.toString('base64'),
        ciphertextSize,
        ...(options.contextToken === undefined ? {} : { contextToken: options.contextToken }),
      })
      return
    } catch (error) {
      lastError = error
      if (error instanceof Error && error.message.includes('被拒绝')) throw error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('CDN 上传失败')
}
