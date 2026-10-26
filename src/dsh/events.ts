/** 从 DSH durable 事件中选择可以投递到微信的最终文本。 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 从一个会话事件里读出要发回的文本。
 *
 * 带工具调用的消息是「旁白」不是回答：模型每一步都会提交一条 `assistant/message`，
 * 大多数步骤是在说「接下来我要……」然后真的去调工具。单独发出去就停在一个冒号上。
 * 被中断的一轮没有回答，它残留的半句话也不发——那读起来像被截断的回复，比沉默更糟。
 *
 * @param event - 已提交的会话事件。
 * @returns 要发送的文本；这个事件不是回答时返回 undefined。
 */
export function extractAssistantText(event: unknown): string | undefined {
  if (!isRecord(event) || event['type'] !== 'assistant/message') return undefined
  const data = event['data']
  if (!isRecord(data)) return undefined
  if (data['interrupted'] === true) return undefined
  const message = data['message']
  if (!isRecord(message)) return undefined
  const content = message['content']
  if (!Array.isArray(content)) return undefined

  // 先看有没有工具调用：有就说明这条是本步的引子。
  const callsTool = content.some(block => isRecord(block) && block['type'] === 'tool-call')
  if (callsTool) return undefined

  const text = content
    .filter((block): block is { type: 'text'; text: string } =>
      isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string')
    .map(block => block.text)
    .join('')

  // 纯工具的一轮没有可展示的话；空消息在聊天里会渲染成一个空气泡。
  return text.trim() === '' ? undefined : text
}

/** 模型一步里「说了什么」与「在调哪个工具」。 */
export interface ToolActivity {
  /** 这一步的旁白文本；模型没说话时缺省。 */
  narration?: string
  /** 模型请求调用的第一个工具名。 */
  toolName?: string
}

/**
 * 从一条 `assistant/message` 里读出「它正在干什么」。
 *
 * 带工具调用的一步不会当回答发出去（会停在一个冒号上），但它恰好是模型自己
 * 对当前动作的描述——比插件的固定台词推确。只用它做进度提示，不影响正文。
 *
 * @param event - 已提交的会话事件。
 * @returns 旁白与工具名；不是带工具调用的一步时返回 undefined。
 */
export function extractToolActivity(event: unknown): ToolActivity | undefined {
  if (!isRecord(event) || event['type'] !== 'assistant/message') return undefined
  const data = event['data']
  if (!isRecord(data)) return undefined
  const message = data['message']
  if (!isRecord(message)) return undefined
  const content = message['content']
  if (!Array.isArray(content)) return undefined

  const call = content.find((block): block is { type: string; name?: unknown } =>
    isRecord(block) && block['type'] === 'tool-call')
  if (call === undefined) return undefined

  const narration = content
    .filter((block): block is { type: 'text'; text: string } =>
      isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string')
    .map(block => block.text)
    .join('')
    .trim()
  const toolName = typeof call.name === 'string' && call.name !== '' ? call.name : undefined
  return {
    ...(narration === '' ? {} : { narration }),
    ...(toolName === undefined ? {} : { toolName }),
  }
}
