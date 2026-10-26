/**
 * 人格卡：解析、校验、归一化。
 *
 * 纯函数，不碰文件系统也不碰网络——加载（扫目录、看 mtime）在 store.ts，
 * 这里只负责「给一段 unknown，还一张类型明确的卡，或者一组能显示给人看的问题」。
 *
 * @module wechat-persona/persona/card
 */

/** 人格的说话方式。三段分开存，是为了让 GUI 能逐段编辑而不互相覆盖。 */
export interface PersonaPrompt {
  /** 立人设的一句话，写「你是谁」。 */
  identity: string
  /** 风格约束，一行一条。 */
  style: string[]
  /** 行为规则。 */
  rules: string[]
  /** 明确不做的事。 */
  forbidden: string[]
}

export interface PersonaSampling {
  temperature: number
  maxTokens: number
}

/** 出站文本的硬约束：先写进 prompt，发送时再切。 */
export interface PersonaReply {
  maxChars: number
  split: 'paragraph' | 'sentence' | 'none'
}

export interface PersonaProactive {
  enabled: boolean
  minIdleHours: number
  /** [开始, 结束]，跨零点允许，如 ['23:00','08:00']。 */
  quietHours: [string, string]
}

export interface PersonaMedia {
  understandImages: boolean
  sendStickers: boolean
}

export interface PersonaExample {
  user: string
  assistant: string
}

export interface PersonaCard {
  id: string
  name: string
  aliases: string[]
  description: string
  prompt: PersonaPrompt
  sampling: PersonaSampling
  reply: PersonaReply
  examples: PersonaExample[]
  greeting: string
  proactive: PersonaProactive
  media: PersonaMedia
}

export interface CardIssue {
  /** 出错的位置，如 `prompt.identity`。 */
  path: string
  message: string
  severity: 'error' | 'warn'
}

export type ParseResult =
  | { ok: true; card: PersonaCard; warnings: CardIssue[] }
  | { ok: false; issues: CardIssue[] }

const ID_PATTERN = /^[a-z0-9-]{1,32}$/
const MAX_LIST_ITEMS = 8
const MAX_ITEM_CHARS = 60
const MAX_EXAMPLES = 5

const DEFAULTS = {
  sampling: { temperature: 0.7, maxTokens: 800 },
  reply: { maxChars: 120, split: 'paragraph' as const },
  proactive: { enabled: false, minIdleHours: 6, quietHours: ['23:00', '08:00'] as [string, string] },
  media: { understandImages: true, sendStickers: true },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 读一个字符串数组：非数组给空，元素非字符串的丢掉。 */
function readList(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  issues: CardIssue[],
): string[] {
  const value = raw[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    issues.push({ path: `${path}.${key}`, message: '应为字符串数组', severity: 'warn' })
    return []
  }
  const out: string[] = []
  for (const item of value) {
    const text = asString(item)
    if (text === undefined) {
      issues.push({ path: `${path}.${key}`, message: '忽略了非字符串条目', severity: 'warn' })
      continue
    }
    if (text.length > MAX_ITEM_CHARS) {
      issues.push({
        path: `${path}.${key}`,
        message: `条目超过 ${String(MAX_ITEM_CHARS)} 字，已截断：${text.slice(0, 20)}…`,
        severity: 'warn',
      })
      out.push(text.slice(0, MAX_ITEM_CHARS))
      continue
    }
    out.push(text)
  }
  if (out.length > MAX_LIST_ITEMS) {
    issues.push({
      path: `${path}.${key}`,
      message: `超过 ${String(MAX_LIST_ITEMS)} 条，只保留前 ${String(MAX_LIST_ITEMS)} 条`,
      severity: 'warn',
    })
    return out.slice(0, MAX_LIST_ITEMS)
  }
  return out
}

function readNumber(
  raw: unknown,
  fallback: number,
  path: string,
  issues: CardIssue[],
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    issues.push({ path, message: '应为数字，已用默认值', severity: 'warn' })
    return fallback
  }
  const clamped = Math.min(max, Math.max(min, raw))
  if (clamped !== raw) {
    issues.push({ path, message: `超出范围 ${String(min)}–${String(max)}，已夹到 ${String(clamped)}`, severity: 'warn' })
  }
  return clamped
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * 解析一张人格卡。
 *
 * @param raw - `persona.json` 反序列化后的值，不做任何假设。
 * @param expectedId - 目录名。给出时校验与卡片 `id` 一致。
 * @returns 成功时带归一化后的卡片和可忽略的警告；失败时带阻断性问题。
 */
export function parsePersonaCard(raw: unknown, expectedId?: string): ParseResult {
  const issues: CardIssue[] = []
  const warnings: CardIssue[] = []

  if (!isRecord(raw)) {
    return { ok: false, issues: [{ path: '', message: '人格卡必须是 JSON 对象', severity: 'error' }] }
  }

  const id = asString(raw.id) ?? expectedId
  if (id === undefined) {
    issues.push({ path: 'id', message: '缺少 id（或无法从目录名推断）', severity: 'error' })
  } else if (!ID_PATTERN.test(id)) {
    issues.push({ path: 'id', message: `id 只能是 [a-z0-9-]，1–32 位，当前为「${id}」`, severity: 'error' })
  } else if (expectedId !== undefined && id !== expectedId) {
    issues.push({ path: 'id', message: `与目录名「${expectedId}」不一致`, severity: 'error' })
  }

  const name = asString(raw.name)
  if (name === undefined) issues.push({ path: 'name', message: '缺少 name', severity: 'error' })

  const promptRaw = raw.prompt
  if (!isRecord(promptRaw)) {
    issues.push({ path: 'prompt', message: '缺少 prompt 对象', severity: 'error' })
  }
  const identity = isRecord(promptRaw) ? asString(promptRaw.identity) : undefined
  if (identity === undefined) {
    issues.push({ path: 'prompt.identity', message: '缺少 identity（立人设的一句话）', severity: 'error' })
  } else if (identity.length > 800) {
    warnings.push({ path: 'prompt.identity', message: `identity 有 ${String(identity.length)} 字，过长会稀释后面的约束`, severity: 'warn' })
  }

  const promptSource = isRecord(promptRaw) ? promptRaw : {}
  const prompt: PersonaPrompt = {
    identity: identity ?? '',
    style: readList(promptSource, 'style', 'prompt', warnings),
    rules: readList(promptSource, 'rules', 'prompt', warnings),
    forbidden: readList(promptSource, 'forbidden', 'prompt', warnings),
  }

  const samplingRaw = isRecord(raw.sampling) ? raw.sampling : {}
  const sampling: PersonaSampling = {
    temperature: readNumber(samplingRaw.temperature, DEFAULTS.sampling.temperature, 'sampling.temperature', warnings, 0, 2),
    maxTokens: Math.round(readNumber(samplingRaw.maxTokens, DEFAULTS.sampling.maxTokens, 'sampling.maxTokens', warnings, 64, 32_768)),
  }

  const replyRaw = isRecord(raw.reply) ? raw.reply : {}
  const splitRaw = replyRaw.split
  const split: PersonaReply['split'] =
    splitRaw === 'sentence' || splitRaw === 'none' || splitRaw === 'paragraph' ? splitRaw : DEFAULTS.reply.split
  if (splitRaw !== undefined && split !== splitRaw) {
    warnings.push({ path: 'reply.split', message: '只能是 paragraph/sentence/none，已用 paragraph', severity: 'warn' })
  }
  const reply: PersonaReply = {
    maxChars: Math.round(readNumber(replyRaw.maxChars, DEFAULTS.reply.maxChars, 'reply.maxChars', warnings, 20, 4096)),
    split,
  }

  const examples: PersonaExample[] = []
  if (raw.examples !== undefined) {
    if (!Array.isArray(raw.examples)) {
      warnings.push({ path: 'examples', message: '应为数组，已忽略', severity: 'warn' })
    } else {
      for (const entry of raw.examples.slice(0, MAX_EXAMPLES)) {
        if (!isRecord(entry)) continue
        const user = asString(entry.user)
        const assistant = asString(entry.assistant)
        if (user === undefined || assistant === undefined) {
          warnings.push({ path: 'examples', message: '忽略了缺少 user/assistant 的示例', severity: 'warn' })
          continue
        }
        examples.push({ user, assistant })
      }
      if (raw.examples.length > MAX_EXAMPLES) {
        warnings.push({ path: 'examples', message: `超过 ${String(MAX_EXAMPLES)} 组，只保留前 ${String(MAX_EXAMPLES)} 组`, severity: 'warn' })
      }
    }
  }

  const proactiveRaw = isRecord(raw.proactive) ? raw.proactive : {}
  const quietRaw = proactiveRaw.quietHours
  let quietHours: [string, string] = DEFAULTS.proactive.quietHours
  if (Array.isArray(quietRaw) && quietRaw.length === 2) {
    const [start, end] = quietRaw
    const startOk = typeof start === 'string' && TIME_PATTERN.test(start)
    const endOk = typeof end === 'string' && TIME_PATTERN.test(end)
    if (startOk && endOk) quietHours = [start, end]
    else warnings.push({ path: 'proactive.quietHours', message: '应为 ["HH:mm","HH:mm"]，已用默认值', severity: 'warn' })
  } else if (quietRaw !== undefined) {
    warnings.push({ path: 'proactive.quietHours', message: '应为两项数组，已用默认值', severity: 'warn' })
  }
  const proactive: PersonaProactive = {
    enabled: proactiveRaw.enabled === true,
    minIdleHours: readNumber(proactiveRaw.minIdleHours, DEFAULTS.proactive.minIdleHours, 'proactive.minIdleHours', warnings, 1, 720),
    quietHours,
  }

  const mediaRaw = isRecord(raw.media) ? raw.media : {}
  const media: PersonaMedia = {
    understandImages: mediaRaw.understandImages !== false,
    sendStickers: mediaRaw.sendStickers !== false,
  }

  if (issues.length > 0) return { ok: false, issues }

  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases.map(asString).filter((value): value is string => value !== undefined)
    : []

  return {
    ok: true,
    warnings,
    card: {
      id: id as string,
      name: name as string,
      aliases,
      description: asString(raw.description) ?? '',
      prompt,
      sampling,
      reply,
      examples,
      greeting: asString(raw.greeting) ?? '',
      proactive,
      media,
    },
  }
}
