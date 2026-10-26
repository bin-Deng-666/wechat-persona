/**
 * 一条回答拆成几个气泡。
 *
 * 这里和 `text.ts` 的分工：`text.ts` 解决「传输上限」（超长必须切，否则被拒），
 * 这个模块解决「聊天手感」（短句、分几条说）。
 *
 * 三个参数各自有硬边界，缺一个都会退化成刷屏或整块：
 * - `softChars`：理想单条长度，来自人格卡 `reply.maxChars`（闲聊 120 字左右）
 * - `hardChars`：传输上限，超过它就一定切（默认 2000）
 * - `maxBubbles`：一次回答最多几个气泡，超出的尾部并进最后一条，避免 8 连发
 *
 * @module wechat-persona/bridge/bubbles
 */

import { splitText, type SplitMode } from './text.ts'
import type { PersonaCard } from '../persona/card.ts'
import type { ChatSettings } from '../persona/settings.ts'

/** 一次回答的发送形态。 */
export interface ReplyPlan {
  /** 理想单条长度；来自人格卡。 */
  softChars: number
  /** 单条硬上限；超过就切。 */
  hardChars: number
  /** 切分粒度。 */
  splitMode: SplitMode
  /** 最多几个气泡。 */
  maxBubbles: number
  /** 气泡之间的间隔，毫秒。 */
  gapMs: number
}

/** 没有画像时的兜底：短、但别碎。 */
export const DEFAULT_REPLY_PLAN: ReplyPlan = {
  softChars: 400,
  hardChars: 2_000,
  splitMode: 'paragraph',
  maxBubbles: 4,
  gapMs: 700,
}

/**
 * 把回答排成气泡序列。
 *
 * 先按 `softChars` 自然切，再把超出 `maxBubbles` 的尾部合并——合并时不超过 `hardChars`，
 * 所以「合并」不会制造出一条发不出去的巨消息。
 *
 * @param text - 模型回答原文。
 * @param plan - 发送形态；缺省用 {@link DEFAULT_REPLY_PLAN}。
 * @returns 至少一条、至多 `maxBubbles` 条文本；空输入返回空数组。
 */
export function planBubbles(text: string, plan: ReplyPlan = DEFAULT_REPLY_PLAN): string[] {
  const trimmed = text.trim()
  if (trimmed === '') return []

  const hardChars = Math.max(1, plan.hardChars)
  const softChars = Math.min(Math.max(1, plan.softChars), hardChars)
  const maxBubbles = Math.max(1, plan.maxBubbles)

  const chunks = splitText(trimmed, softChars, plan.splitMode)
  if (chunks.length <= maxBubbles) return chunks

  // 保留前 maxBubbles-1 条，其余合并成最后一条；合并后超过硬上限就再硬切，
  // 宁可多一条也不能造出一条发不出去的巨消息。
  const keep = chunks.slice(0, maxBubbles - 1)
  const merged = chunks.slice(maxBubbles - 1).join('\n\n')
  const tail = merged.length <= hardChars ? [merged] : splitText(merged, hardChars, 'paragraph')
  return [...keep, ...tail]
}

/** 传输层硬上限：再长就会被服务端拒绝。 */
export const HARD_CHARS = 2_000

/**
 * 从人格卡 + 聊天设置算出这个聊天的发送形态。
 *
 * 优先级：聊天设置 → 人格卡 → 兜底。人格卡里的 `reply` 以前只进 prompt、
 * 从不影响实际发送，所以写了「分条」也没用——这里把它接上。
 *
 * @param card - 当前人格卡。
 * @param settings - 这个聊天的设置，可缺省。
 */
export function resolvePlan(card: PersonaCard, settings?: ChatSettings): ReplyPlan {
  return {
    softChars: settings?.maxChars ?? card.reply.maxChars,
    hardChars: HARD_CHARS,
    splitMode: settings?.split ?? card.reply.split,
    maxBubbles: DEFAULT_REPLY_PLAN.maxBubbles,
    gapMs: DEFAULT_REPLY_PLAN.gapMs,
  }
}
