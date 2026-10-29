/** 从 DSH durable 事件中提取回答与真实、可公开的执行进展。 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function contentOf(event: unknown): { data: Record<string, unknown>; content: Record<string, unknown>[] } | undefined {
  if (!isRecord(event) || event['type'] !== 'assistant/message') return undefined
  const data = event['data']
  if (!isRecord(data) || data['interrupted'] === true) return undefined
  const message = data['message']
  if (!isRecord(message) || !Array.isArray(message['content'])) return undefined
  return { data, content: message['content'].filter(isRecord) }
}

function textOf(content: readonly Record<string, unknown>[]): string | undefined {
  const text = content
    .filter(block => block['type'] === 'text' && typeof block['text'] === 'string')
    .map(block => String(block['text']))
    .join('')
  return text.trim() === '' ? undefined : text
}

/** 最终回答：没有工具调用、不是中断残句的正文。 */
export function extractAssistantText(event: unknown): string | undefined {
  const parsed = contentOf(event)
  if (parsed === undefined || parsed.content.some(block => block['type'] === 'tool-call')) return undefined
  return textOf(parsed.content)
}

/**
 * 有工具调用的旁白不是最终回答，但它是用户真正需要的执行进展。
 * 只保留模型明确写给用户的短文本；不把 reasoning、命令参数或工具输出带到微信。
 */
export function extractProgressText(event: unknown): string | undefined {
  const parsed = contentOf(event)
  if (parsed === undefined || !parsed.content.some(block => block['type'] === 'tool-call')) return undefined
  const text = textOf(parsed.content)?.trim()
  if (text === undefined) return undefined
  return Array.from(text).length > 500 ? `${Array.from(text).slice(0, 500).join('')}…` : text
}

/** 工具名称只用于低频状态更新，绝不暴露参数、路径和输出。 */
export function extractToolName(event: unknown): string | undefined {
  if (!isRecord(event) || event['type'] !== 'tool/call') return undefined
  const data = event['data']
  if (!isRecord(data)) return undefined
  return typeof data['name'] === 'string' && data['name'].trim() !== '' ? data['name'].trim() : undefined
}
