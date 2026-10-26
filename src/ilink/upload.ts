/**
 * CDN 上传：图片和文件共用的前半段。
 *
 * 顺序固定，任一步失败后一步都没有意义：
 *   getuploadurl（声明明文长度/MD5/密文长度）→ 加密 → POST 密文 → 取 `x-encrypted-param`
 *
 * 最容易踩的坑是「上传返回 200 但没带 x-encrypted-param」：
 * 状态码看着成功，收件人那边却永远取不到这个对象。
 *
 * @module wechat-persona/ilink/upload
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

/** `getuploadurl` 的 media_type：注意它和消息项的 type 是两套编号。 */
export type UploadMediaType = 1 | 2 | 3 | 4

export interface UploadMediaOptions {
  signal?: AbortSignal
  api: ApiClient
  baseUrl: string
  token: string
  to: string
  /** 明文内容。 */
  data: Uint8Array
  mediaType: UploadMediaType
  cdnBaseUrl?: string
  fetchImpl?: typeof fetch
  /** CDN 上的对象名；默认 uuid。 */
  filekey?: string
}

export interface UploadedMedia {
  /** 本次使用的 AES key（16 字节）。 */
  key: Buffer
  /** 密文长度，发送时服务端会核对。 */
  ciphertextSize: number
  /** 上传后拿到的下载参数，放进 media.encrypt_query_param。 */
  downloadParam: string
}

/**
 * 加密并上传一段内容。
 *
 * @param options - 明文与传输层。
 * @returns key / 密文长度 / 下载参数。
 * @throws 任一步失败时抛错；4xx 不重试（被拒就是被拒），5xx 重试到上限。
 */
export async function uploadMedia(options: UploadMediaOptions): Promise<UploadedMedia> {
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
    mediaType: options.mediaType,
    to: options.to,
    rawsize: plaintext.length,
    rawfilemd5: createHash('md5').update(plaintext).digest('hex'),
    filesize: ciphertextSize,
    aeskey: key.toString('hex'),
    signal: options.signal,
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
    options.signal?.throwIfAborted()
    try {
      const response = await fetchImpl(target, {
        signal: options.signal,
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
        throw new Error('CDN 上传返回 200 但没有 x-encrypted-param 头，内容取不到')
      }
      return { key, ciphertextSize, downloadParam }
    } catch (error) {
      options.signal?.throwIfAborted()
      lastError = error
      if (error instanceof Error && error.message.includes('被拒绝')) throw error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('CDN 上传失败')
}
