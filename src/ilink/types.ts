/**
 * iLink 协议的消息形状。
 *
 * 字段名与数值判别式来自腾讯 openclaw-weixin 的协议文档；线上除了文档明确写死的，
 * 其余一律当可选处理——下游解析必须防御，不能信这里的类型。
 *
 * Adapted from @tencent-weixin/openclaw-weixin (MIT, Copyright (C) 2026 Tencent)
 *
 * @module wechat-persona/ilink/types
 */

/** 谁发的：1 用户，2 Bot。 */
export const MessageType = { USER: 1, BOT: 2 } as const

/** 消息生命周期：0 新、1 生成中、2 完成。 */
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const

/** `MessageItem.type` 的判别式。 */
export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const

/** 加密媒体在 CDN 上的引用。 */
export interface MediaRef {
  /** 下载参数。 */
  encrypt_query_param?: string
  /** AES key：base64，或 32 位 hex。 */
  aes_key?: string
  /** 打包方式：0 只加密 file id，1 连缩略图一起。 */
  encrypt_type?: number
  /** 完整 URL，优先于用 CDN base 拼出来的地址。 */
  full_url?: string
}

/** 文本。 */
export interface TextItem {
  text?: string
}

/** 图片。 */
export interface ImageItem {
  /** 32 位 hex 的 AES key，优先于 `media.aes_key`。 */
  aeskey?: string
  /** 发送方声明的密文长度。 */
  mid_size?: number
  media?: MediaRef
  thumb_media?: MediaRef
}

/** 语音；`text` 是服务端转写（有就直接用）。 */
export interface VoiceItem {
  text?: string
  encode_type?: number
  bits_per_sample?: number
  sample_rate?: number
  playtime?: number
  media?: MediaRef
}

/** 文件。 */
export interface FileItem {
  file_name?: string
  /** 明文长度，十进制字符串。 */
  len?: string
  media?: MediaRef
}

/** 视频。 */
export interface VideoItem {
  video_size?: number
  media?: MediaRef
  thumb_media?: MediaRef
}

/** 消息体的一个元素。 */
export interface MessageItem {
  type?: number
  text_item?: TextItem
  image_item?: ImageItem
  voice_item?: VoiceItem
  file_item?: FileItem
  video_item?: VideoItem
  msg_id?: string
}

/** 一条入站消息。 */
export interface WeixinMessage {
  message_id?: number | string
  from_user_id?: string
  to_user_id?: string
  /** 见 {@link MessageType}。 */
  message_type?: number
  /** 见 {@link MessageState}。 */
  message_state?: number
  item_list?: MessageItem[]
  /** 回复时必须原样回传的会话令牌。 */
  context_token?: string
  run_id?: string
  /** 引用的消息 id（新版客户端只给 id，不给内容）。 */
  quote?: { message_id?: number | string }
}

/** 一次长轮询的结果。 */
export interface GetUpdatesResult {
  msgs: readonly unknown[]
  /** 下次轮询用的游标。 */
  get_updates_buf: string | undefined
  /** 服务端建议的轮询超时。 */
  longpolling_timeout_ms: number | undefined
}
