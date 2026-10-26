/**
 * 一条回答拆成几个气泡。
 *
 * 这里和 `text.ts` 的分工：`text.ts` 解决「传输上限」（超长必须切，否则被拒），
 * 这个模块解决「聊天手感」（短句、分几条说）。
 *
 * 三个参数各自有硬边界，缺一个都会退化成刷屏或整块：
 * - `softChars`：理想单条长度，来自人格卡 `reply.maxChars`（闲聊 120 字左右）
 * - `hardChars`：传输上限，超过它就一定切（默认 2000）
 * - 条数不设上限：短回答自然只有一条，长回答按段落数决定，不做「尾部合并」（那会让某一条偷偷超限）
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
  /** 气泡之间的间隔，毫秒。 */
  gapMs: number
}

/** 默认单条长度：短于这个值就一条发完，不为了「像人」把话掰碎。 */
export const DEFAULT_SOFT_CHARS = 600

/** 没有画像时的兜底：短、但别碎。 */
export const DEFAULT_REPLY_PLAN: ReplyPlan = {
  softChars: DEFAULT_SOFT_CHARS,
  hardChars: 2_000,
  splitMode: 'paragraph',
  gapMs: 700,
}

/**
 * 把回答排成气泡序列。
 *
 * 按 `softChars` 自然切，`hardChars` 兜底。
 *
 * @param text - 模型回答原文。
 * @param plan - 发送形态；缺省用 {@link DEFAULT_REPLY_PLAN}。
 * @returns 至少一条文本；空输入返回空数组。
 */
export function planBubbles(text: string, plan: ReplyPlan = DEFAULT_REPLY_PLAN): string[] {
  const trimmed = text.trim()
  if (trimmed === '') return []

  const hardChars = Math.max(1, plan.hardChars)
  const softChars = Math.min(Math.max(1, plan.softChars), hardChars)

  // [分条] 是模型主动选择的消息边界；没有标记时维持一条短回复。
  return trimmed.split('[分条]').flatMap(part => {
    const text = part.trim()
    if (text === '') return []
    // 表情标记不参与文字长度计算，避免短气泡把素材 ID 切断。
    const stickers = text.match(/\[表情[:：][^\]]*\]/gu) ?? []
    const body = text.replace(/\[表情[:：][^\]]*\]/gu, '').trim()
    const chunks = body === '' ? [] : splitText(body,
      plan.splitMode === 'none' ? hardChars : softChars,
      plan.splitMode === 'none' ? 'paragraph' : plan.splitMode)
    if (stickers.length === 0) return chunks
    // 一个气泡里可能有多张表情：全部带着，交给发送端逐张发。
    const prefix = stickers.join(' ')
    if (chunks.length === 0) return [prefix]
    chunks[0] = `${prefix} ${chunks[0]}`
    return chunks
  })
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
  const mode = settings?.split ?? card.reply.split
  // 只有「按句子切」的人格才真的碎碎念；普通人格把 maxChars 当风格提示，
  // 不拿它当气泡大小——否则一句 300 字的正常回答会被掰成三条消息发出去。
  const bubbly = mode === 'sentence'
  return {
    softChars: settings?.maxChars ?? (bubbly ? card.reply.maxChars : DEFAULT_SOFT_CHARS),
    hardChars: HARD_CHARS,
    splitMode: mode,
    gapMs: DEFAULT_REPLY_PLAN.gapMs,
  }
}
