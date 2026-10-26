/**
 * 入站媒体的下载与解密。
 *
 * CDN 上的对象是 AES-128-ECB + PKCS#7 的密文，key 随消息下发而不是派生的。
 * key 有两种编码：16 字节 base64（图片常用），或 32 字符 hex 的 base64（文件/语音/视频）。
 * 猜错的表现是「解密失败」，看起来像文件损坏而不是 key 读错了——所以这里拒绝一切
 * 无法分类的值，而不是硬截断。
 *
 * 传输层注入，便于用固定密文做单测。
 *
 * 改编自 @tencent-weixin/openclaw-weixin (MIT, Copyright (C) 2026 Tencent)
 * 的 `cdn/aes-ecb.ts`、`cdn/pic-decrypt.ts`、`cdn/cdn-url.ts`。
 *
 * @module wechat-persona/ilink/media
 */

import { createDecipheriv, createCipheriv } from 'node:crypto'

import type { MediaRef, MessageItem } from './types.ts'

/** 媒体 CDN 基址。 */
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

const BLOCK_BYTES = 16

/** 一类入站媒体。 */
export type MediaKind = 'image' | 'file' | 'voice' | 'video'

/** 从消息里解析出的一份媒体。 */
export interface InboundMedia {
  kind: MediaKind
  /** `encrypt_query_param`；只有 `full_url` 时为空串。 */
  encryptQueryParam: string
  /** `aes_key` 的 base64 形式；图片的 hex `aeskey` 已换算成它。 */
  aesKeyBase64?: string
  /** 完整的下载地址，优先使用。 */
  fullUrl?: string
  /** 文件名（文件类）。 */
  name?: string
}

/**
 * 把服务端的 `aes_key` 还原成 16 字节。
 * @param aesKeyBase64 - 原样的 `aes_key` 字段。
 * @throws 解出来不是 16 字节 / 32 字符 hex 时抛错。
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64')
  if (decoded.length === BLOCK_BYTES) return decoded
  if (decoded.length === BLOCK_BYTES * 2 && /^[0-9a-fA-F]{32}$/u.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(`aes_key 必须是 16 字节或 32 字符 hex，实际 ${String(decoded.length)} 字节`)
}

/** AES-128-ECB 解密（PKCS#7 由 cipher 自动去除）。 */
export function decryptAesEcb(ciphertext: Uint8Array, key: Uint8Array): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** AES-128-ECB 加密，单测与上传共用。 */
export function encryptAesEcb(plaintext: Uint8Array, key: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/**
 * 拼下载地址。
 * @param encryptQueryParam - 下载参数。
 * @param cdnBaseUrl - CDN 基址。
 */
export function buildCdnDownloadUrl(encryptQueryParam: string, cdnBaseUrl: string): string {
  const base = cdnBaseUrl.endsWith('/') ? cdnBaseUrl.slice(0, -1) : cdnBaseUrl
  // 参数是不透明的，必须 percent-encode：里面常有 `+`，不编码会被服务端解成空格。
  return `${base}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`
}

function refOf(ref: MediaRef | undefined): Omit<InboundMedia, 'kind'> | undefined {
  if (ref === undefined) return undefined
  const encryptQueryParam = ref.encrypt_query_param ?? ''
  const fullUrl = ref.full_url !== undefined && ref.full_url !== '' ? ref.full_url : undefined
  // 两个都没有就没法下载，这份媒体直接丢掉。
  if (encryptQueryParam === '' && fullUrl === undefined) return undefined
  return {
    encryptQueryParam,
    ...(fullUrl === undefined ? {} : { fullUrl }),
    ...(ref.aes_key === undefined || ref.aes_key === '' ? {} : { aesKeyBase64: ref.aes_key }),
  }
}

/**
 * 从 `item_list` 里抽出所有可下载的媒体。
 *
 * 图片的 `image_item.aeskey` 是 hex（优先级高于 `media.aes_key`），这里统一换成 base64，
 * 让下游只面对一种编码。
 * @param items - 消息体。
 */
export function extractMedia(items: readonly MessageItem[] | undefined): InboundMedia[] {
  const out: InboundMedia[] = []
  for (const item of items ?? []) {
    if (item.type === undefined) continue
    if (item.type === 2) {
      const image = item.image_item
      const base = refOf(image?.media)
      if (base === undefined) continue
      const aesKeyBase64 = image?.aeskey !== undefined && /^[0-9a-fA-F]{32}$/u.test(image.aeskey)
        ? Buffer.from(image.aeskey, 'hex').toString('base64')
        : base.aesKeyBase64
      out.push({
        kind: 'image',
        encryptQueryParam: base.encryptQueryParam,
        ...(aesKeyBase64 === undefined ? {} : { aesKeyBase64 }),
        ...(base.fullUrl === undefined ? {} : { fullUrl: base.fullUrl }),
      })
      continue
    }
    if (item.type === 3) {
      const base = refOf(item.voice_item?.media)
      if (base !== undefined) out.push({ kind: 'voice', ...base })
      continue
    }
    if (item.type === 4) {
      const base = refOf(item.file_item?.media)
      if (base !== undefined) {
        out.push({
          kind: 'file',
          ...base,
          ...(item.file_item?.file_name === undefined ? {} : { name: item.file_item.file_name }),
        })
      }
      continue
    }
    if (item.type === 5) {
      const base = refOf(item.video_item?.media)
      if (base !== undefined) out.push({ kind: 'video', ...base })
    }
  }
  return out
}

export interface DownloadOptions {
  cdnBaseUrl?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

/**
 * 下载并解密一份媒体。
 * @param media - 解析出的描述。
 * @param options - CDN 基址、传输层与取消信号。
 * @returns 明文字节。
 * @throws 下载失败或解密失败时抛错，让调用方报告而不是悄悄丢掉媒体。
 */
export async function downloadMedia(media: InboundMedia, options: DownloadOptions = {}): Promise<Buffer> {
  const url = media.fullUrl ?? buildCdnDownloadUrl(media.encryptQueryParam, options.cdnBaseUrl ?? CDN_BASE_URL)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const response = await fetchImpl(url, options.signal === undefined ? {} : { signal: options.signal })
  if (!response.ok) throw new Error(`CDN 下载失败 ${String(response.status)} ${response.statusText}`)
  const body = Buffer.from(await response.arrayBuffer())
  // 没有 key 就说明是明文存储的：再解密一次会在 padding 上失败。
  if (media.aesKeyBase64 === undefined) return body
  return decryptAesEcb(body, parseAesKey(media.aesKeyBase64))
}

/** 按魔数猜图片的 MIME；猜不出返回 undefined（调用方当作文件处理）。 */
export function sniffImageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | undefined {
  const head = bytes.subarray(0, 12)
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 4 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'image/gif'
  if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
    && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'image/webp'
  return undefined
}
