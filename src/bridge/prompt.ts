/**
 * 把人格塞进一轮对话。
 *
 * DSH 的会话 system prompt 由宿主（web app）组装，插件没有「设置会话 system prompt」的入口，
 * 所以人格只能随消息一起带进去。做法是：
 *
 * - **每个会话的第一轮**：注入完整的人设块（身份/风格/规则/禁止/此刻/长度/示例）
 * - **之后每一轮**：只带一行提醒（名字 + 前两条风格）
 *
 * 为什么不是每轮都注入完整块：那会把每轮上下文翻倍，且模型会开始复述设定。
 * 为什么不是只注入一次：上下文压缩会丢掉最早的消息，只留一行提醒成本几乎为零。
 *
 * @module wechat-persona/bridge/prompt
 */

import type { PersonaCard } from '../persona/card.ts'
import { buildSystemPrompt, type PromptContext } from '../persona/prompt.ts'

/** 完整人设块的开始标记。 */
export const PERSONA_BEGIN = '【角色设定·仅用于本对话】'
/** 完整人设块的结束标记。 */
export const PERSONA_END = '【设定结束】'

export interface ComposeInput {
  card: PersonaCard
  /** 对方的显示名。 */
  peer?: string
  /** 注入时间，测试用。 */
  now?: Date
  /** IANA 时区。 */
  timeZone?: string
  /** 记忆摘要。 */
  memory?: string
  /** 本地表情库里的名字。 */
  stickers?: readonly string[]
  /** 用户这一轮说的话（媒体消息是占位文本）。 */
  text: string
  /** 是否为本会话的第一轮。 */
  first: boolean
}

/**
 * 组装一条投递给 agent 的文本。
 *
 * @param input - 卡片、上下文与本轮原文。
 * @returns 以人设块或提醒开头的完整文本；`text` 为空时用占位符，避免空消息。
 */
export function composeInboundText(input: ComposeInput): string {
  const body = input.text.trim() === '' ? '（对方发来一条没有文字的消息）' : input.text

  if (input.first) {
    const context: PromptContext = {
      ...(input.peer === undefined ? {} : { peer: input.peer }),
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
      ...(input.memory === undefined ? {} : { memory: input.memory }),
      ...(input.stickers === undefined ? {} : { stickers: input.stickers }),
    }
    const persona = buildSystemPrompt(input.card, context)
    return `${PERSONA_BEGIN}\n${persona}\n${PERSONA_END}\n\n${body}`
  }

  return `${reminderOf(input.card)}\n\n${body}`
}

/**
 * 一行角色提醒。
 * @param card - 人格卡。
 */
export function reminderOf(card: PersonaCard): string {
  const style = card.prompt.style.slice(0, 2)
  const tail = style.length === 0 ? '' : `：${style.join('；')}`
  return `（继续扮演「${card.name}」${tail}）`
}
