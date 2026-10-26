/**
 * 入站报文形状诊断。
 *
 * iLink 只公开了一部分字段。协议升级，或出现我们没有实现的场景（例如群聊）时，
 * 报文里可能多出没解析的字段，而现有代码会**静默丢弃**：看不到、也不知道为什么。
 *
 * 这里把一条原始报文压成「可以安全写日志」的形状描述：只记字段名、id 和类型；
 * `context_token`、`aes_key`、媒体引用这类凭据与素材**只记是否存在**，绝不记值。
 *
 * @module wechat-persona/ilink/diagnose
 */

/** 已知的顶层字段。 */
const MESSAGE_KEYS = new Set([
  'message_id', 'from_user_id', 'to_user_id', 'message_type', 'message_state',
  'item_list', 'context_token', 'run_id', 'quote',
])

/** 已知的消息项字段。 */
const ITEM_KEYS = new Set(['type', 'text_item', 'image_item', 'voice_item', 'file_item', 'video_item', 'msg_id'])

/** 一条入站报文的日志形状。 */
export interface InboundShape {
  messageId?: string
  fromId?: string
  toId?: string
  messageType?: number
  messageState?: number
  itemTypes: number[]
  /** 是否带了 context_token（不记录其值）。 */
  hasContextToken: boolean
  runId?: string
  quotedMessageId?: string
  /** 顶层不认识的字段名。 */
  unknown: string[]
  /** 消息项里不认识的字段名。 */
  unknownItems: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function id(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

/**
 * 把一条原始入站报文压成形状描述。
 * @param raw - 长轮询交上来的原始条目。
 * @returns 形状；不是对象时返回 undefined（调用方据此记录「无法识别」）。
 */
export function describeInbound(raw: unknown): InboundShape | undefined {
  if (!isRecord(raw)) return undefined
  const shape: InboundShape = {
    itemTypes: [],
    hasContextToken: raw['context_token'] !== undefined && raw['context_token'] !== '',
    unknown: [],
    unknownItems: [],
  }

  const messageId = id(raw['message_id'])
  if (messageId !== undefined) shape.messageId = messageId
  const fromId = id(raw['from_user_id'])
  if (fromId !== undefined) shape.fromId = fromId
  const toId = id(raw['to_user_id'])
  if (toId !== undefined) shape.toId = toId
  if (typeof raw['message_type'] === 'number') shape.messageType = raw['message_type']
  if (typeof raw['message_state'] === 'number') shape.messageState = raw['message_state']
  const runId = id(raw['run_id'])
  if (runId !== undefined) shape.runId = runId

  const quote = raw['quote']
  if (isRecord(quote)) {
    const quoted = id(quote['message_id'])
    if (quoted !== undefined) shape.quotedMessageId = quoted
  }

  const items = raw['item_list']
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!isRecord(item)) continue
      if (typeof item['type'] === 'number') shape.itemTypes.push(item['type'])
      for (const key of Object.keys(item)) if (!ITEM_KEYS.has(key)) shape.unknownItems.push(key)
    }
  }

  for (const key of Object.keys(raw)) if (!MESSAGE_KEYS.has(key)) shape.unknown.push(key)
  return shape
}

/**
 * 非对象报文（连形状都读不出来）的兜底摘要：只记类型与字段名。
 * @param raw - 原始条目。
 */
export function summarizeRaw(raw: unknown): string {
  if (!isRecord(raw)) return `type=${typeof raw}`
  return `type=object keys=${Object.keys(raw).join(',')}`
}

/**
 * 这条报文值不值得记一条诊断日志。
 *
 * 正常单聊报文返回 false（不产生噪音）；缺 from_user_id、带未知字段、或显式开启
 * 详细诊断时返回 true。
 * @param shape - {@link describeInbound} 的结果。
 * @param verbose - 是否记录每一条入站报文。
 */
export function needsDiagnosis(shape: InboundShape, verbose: boolean): boolean {
  if (shape.fromId === undefined) return true
  if (shape.unknown.length > 0 || shape.unknownItems.length > 0) return true
  return verbose
}
