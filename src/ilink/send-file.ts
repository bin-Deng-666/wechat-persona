/**
 * 把文件发进微信。
 *
 * 这是「能干活」闭环的最后一环：模型在电脑上做出了 docx/pdf，却只能说
 * 「文件在桌面上，你自己去拿」——在微信里等于没做完。
 *
 * 协议细节（来自 dsh-channel-wechat 与腾讯官方 @tencent-weixin/openclaw-weixin 两套实现）：
 * - 消息项 `type: 4`（file），但 `getuploadurl` 的 `media_type: 3`
 * - `file_item.len` 是**明文**字节数的十进制字符串
 * - `aes_key` 是「先写 hex 字符串、再 base64」，图片与文件同一种写法
 *
 * @module wechat-persona/ilink/send-file
 */

import { basename } from 'node:path'

import type { ApiClient } from './api.ts'
import { uploadMedia } from './upload.ts'

export interface SendFileOptions {
  api: ApiClient
  baseUrl: string
  token: string
  to: string
  clientId?: string
  signal?: AbortSignal
  contextToken?: string
  /** 明文文件内容。 */
  data: Uint8Array
  /** 接收方看到的文件名；缺省用已经带扩展名的 `fileName`。 */
  fileName: string
  cdnBaseUrl?: string
  fetchImpl?: typeof fetch
}

/**
 * 上传并发送一个文件。
 *
 * @param options - 目标、文件名与明文。
 * @throws 任一步失败时抛错，调用方据此决定「发文字说明」还是「报告失败」。
 */
export async function sendFile(options: SendFileOptions): Promise<void> {
  const uploaded = await uploadMedia({
    api: options.api,
    baseUrl: options.baseUrl,
    token: options.token,
    to: options.to,
    data: options.data,
    mediaType: 3,
    signal: options.signal,
    ...(options.cdnBaseUrl === undefined ? {} : { cdnBaseUrl: options.cdnBaseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })

  await options.api.sendFile({
    baseUrl: options.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    label: 'sendmessage(file)',
    token: options.token,
    to: options.to,
    clientId: options.clientId,
    signal: options.signal,
    encryptQueryParam: uploaded.downloadParam,
    // 统一用上传阶段算好的规范编码；图片、文件一致。
    aesKeyBase64: uploaded.aesKeyBase64,
    fileName: sanitizeName(options.fileName),
    plaintextSize: options.data.length,
    ...(options.contextToken === undefined ? {} : { contextToken: options.contextToken }),
  })
}

/**
 * 文件名收窄成「一个安全的名字」。
 *
 * 微信客户端会用这个名字落盘；带路径分隔符或 `..` 的名字在某些客户端上会被拒绝，
 * 甚至变成写到别的目录。只保留 basename 是最小成本的防护。
 */
export function sanitizeName(name: string): string {
  const base = basename(name.replaceAll('\\', '/')).replace(/[\u0000-\u001f]/gu, '').trim()
  return base === '' || base === '.' || base === '..' ? 'file' : base.slice(0, 120)
}
