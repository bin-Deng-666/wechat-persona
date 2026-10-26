/**
 * Prompt 组装：卡片 + 上下文 → system prompt。
 *
 * 纯函数。同一份人格在单测、GUI 预览、真实会话里渲染出的字符串必须完全一致，
 * 所以这里不做任何 IO、不读配置、不看时间以外的环境。
 *
 * 段落顺序固定（身份 → 风格 → 规则 → 禁止 → 此刻 → 长度 → 示例），
 * 便于断言、便于 prompt 缓存命中。
 *
 * @module wechat-persona/persona/prompt
 */

import type { PersonaCard } from './card.ts'

export interface PromptContext {
  /** 对方在微信里的显示名或备注名。 */
  peer?: string
  /** 注入时间，测试用；缺省取当前时间。 */
  now?: Date
  /** IANA 时区，缺省用运行环境的本地时区。 */
  timeZone?: string
  /** 记忆摘要；空则不渲染该行。 */
  memory?: string
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

function formatClock(now: Date, timeZone: string | undefined): string {
  const hour = String(now.getHours()).padStart(2, '0')
  const minute = String(now.getMinutes()).padStart(2, '0')
  if (timeZone === undefined) return `${hour}:${minute}`
  // 用 formatToParts 取数字，避免不同 ICU 版本把时间渲染成「14时05分」。
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).formatToParts(now)
  const pick = (type: string): string => parts.find(part => part.type === type)?.value ?? '00'
  return `${pick('hour')}:${pick('minute')}`
}

function formatWeekday(now: Date, timeZone: string | undefined): string {
  if (timeZone === undefined) return WEEKDAYS[now.getDay()] ?? ''
  const short = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(now)
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(short)
  return index >= 0 ? (WEEKDAYS[index] ?? '') : ''
}

function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => vars[key] ?? whole)
}

/**
 * 组装 system prompt。
 *
 * @param card - 已通过 `parsePersonaCard` 的卡片。
 * @param context - 本轮运行时上下文。
 * @returns 可直接交给模型的 system 文本；空段落整段省略，不留空标题。
 */
export function buildSystemPrompt(card: PersonaCard, context: PromptContext = {}): string {
  const now = context.now ?? new Date()
  const peer = context.peer?.trim() === '' ? undefined : context.peer?.trim()
  const vars: Record<string, string> = {
    name: card.name,
    peer: peer ?? '对方',
    time: formatClock(now, context.timeZone),
    weekday: formatWeekday(now, context.timeZone),
    memory: context.memory?.trim() ?? '',
  }

  const blocks: string[] = []

  const identity = interpolate(card.prompt.identity, vars).trim()
  if (identity !== '') blocks.push(`# 身份\n${identity}`)

  if (card.prompt.style.length > 0) {
    blocks.push(`# 风格\n${card.prompt.style.map(line => `- ${interpolate(line, vars)}`).join('\n')}`)
  }
  if (card.prompt.rules.length > 0) {
    blocks.push(`# 规则\n${card.prompt.rules.map(line => `- ${interpolate(line, vars)}`).join('\n')}`)
  }
  if (card.prompt.forbidden.length > 0) {
    blocks.push(`# 禁止\n${card.prompt.forbidden.map(line => `- ${interpolate(line, vars)}`).join('\n')}`)
  }

  const situation: string[] = [`现在是${new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', ...(context.timeZone ? { timeZone: context.timeZone } : {}) }).format(now)} ${vars.weekday ?? ''} ${vars.time ?? ''}。`]
  if (peer !== undefined) situation.push(`你在微信上和「${peer}」单聊。`)
  if (vars.memory !== '') situation.push(`你记得：${vars.memory}`)
  blocks.push(`# 此刻\n${situation.join('')}`)

  blocks.push(`# 表达长度\n日常闲聊倾向简洁，通常约 ${String(card.reply.maxChars)} 字。任务说明、必要解释和用户要求展开时按内容需要完整回答；单条微信消息的切分由通道处理。`)

  if (card.examples.length > 0) {
    const lines = card.examples.map(example => `对方：${example.user}\n你：${example.assistant}`)
    blocks.push(`# 示例\n${lines.join('\n\n')}`)
  }

  return blocks.join('\n\n')
}
