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

/** 出站文本的硬约束：先写进 prompt，发送时再切。 */
export interface PersonaReply {
  maxChars: number
  split: 'paragraph' | 'sentence' | 'none'
}

export interface PersonaMedia {
  /** 是否把当前联系人的表情目录与识别指令写进系统提示词。 */
  sendStickers: boolean
}

export interface PersonaExample {
  user: string
  assistant: string
}

export interface PersonaCard {
  id: string
  name: string
  description: string
  prompt: PersonaPrompt
  reply: PersonaReply
  examples: PersonaExample[]
  media: PersonaMedia
  /** 干活时报平安的短句；一轮之内不重复。为空时回落到内置库。 */
  progress: string[]
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
/** 报平安短句的上限：够多才不重复，太多则说明写宽了。 */
const MAX_PROGRESS_LINES = 40
const MAX_PROGRESS_CHARS = 20
/**
 * 少于这个数就认为这套写得不够，退回内置库，并在卡上标一条提示。
 *
 * 这个下限**等于**当前的每轮配额：20 秒一句、窗口 200 秒 → ceil(200000/20000) = 10 条。
 * 也就是说 10 条刚好够一轮不重复，一环之内不会重样。
 *
 * 但它是**跨轮**失效的：下一轮从同一批里重洗，同一个联系人连着跑两个长任务，
 * 会看到同样的十句。要缓解就得往上加（比如 20 条），或者让配额随窗口变化。
 *
 * ⚠️ 耦合：如果有人把 `noticeWindowMs` 调大（或 `noticeIntervalMs` 调小），
 * 每轮配额会超过 10，这个下限就不再够用，必须同步上调，否则一轮内必然重复。
 * 两处常量（这里与 `wechat/channel.ts` 的 maxNotices）是一对，改一个要看另一个。
 */
const MIN_PROGRESS_LINES = 10

const DEFAULTS = {
  reply: { maxChars: 120, split: 'paragraph' as const },
  media: { sendStickers: true },
}

/**
 * 读报平安短句。
 *
 * 与 `readList` 分开：那一套的上限是给 prompt 约束用的（8 条、60 字），
 * 短句要的是「够多且够短」，规则完全不同，硬套会让一张卡只能写 8 句。
 *
 * 非法条目不阻断整张卡：超长截断、空串丢弃、重复合并，都记一条可读的警告。
 */
function readProgress(raw: unknown, warnings: CardIssue[]): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    warnings.push({ path: 'progress', message: '应为字符串数组，已回退到内置短句', severity: 'warn' })
    return []
  }
  const seen = new Set<string>()
  const lines: string[] = []
  let dropped = 0
  let clipped = 0
  let duplicated = 0
  for (const item of raw) {
    if (typeof item !== 'string') { dropped += 1; continue }
    const text = item.replace(/\s+/gu, ' ').trim()
    if (text === '') { dropped += 1; continue }
    const chars = Array.from(text)
    const fitted = chars.length > MAX_PROGRESS_CHARS ? `${chars.slice(0, MAX_PROGRESS_CHARS - 1).join('')}…` : text
    if (chars.length > MAX_PROGRESS_CHARS) clipped += 1
    if (seen.has(fitted)) { duplicated += 1; continue }
    seen.add(fitted)
    lines.push(fitted)
  }
  if (dropped > 0) warnings.push({ path: 'progress', message: `忽略了 ${String(dropped)} 条空串或非字符串`, severity: 'warn' })
  if (clipped > 0) warnings.push({ path: 'progress', message: `${String(clipped)} 条超过 ${String(MAX_PROGRESS_CHARS)} 字，已截断`, severity: 'warn' })
  if (duplicated > 0) warnings.push({ path: 'progress', message: `${String(duplicated)} 条重复，已合并`, severity: 'warn' })
  if (lines.length > MAX_PROGRESS_LINES) {
    warnings.push({ path: 'progress', message: `超过 ${String(MAX_PROGRESS_LINES)} 条，只保留前 ${String(MAX_PROGRESS_LINES)} 条`, severity: 'warn' })
    return lines.slice(0, MAX_PROGRESS_LINES)
  }
  if (lines.length > 0 && lines.length < MIN_PROGRESS_LINES) {
    warnings.push({
      path: 'progress',
      message: `只有 ${String(lines.length)} 条，建议至少 ${String(MIN_PROGRESS_LINES)} 条以免一轮内重复；不足时回退到内置短句`,
      severity: 'warn',
    })
    return []
  }
  return lines
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

  const progress = readProgress(raw.progress, warnings)

  const mediaRaw = isRecord(raw.media) ? raw.media : {}
  const media: PersonaMedia = {
    sendStickers: mediaRaw.sendStickers !== false,
  }
  if (mediaRaw.understandImages !== undefined) {
    warnings.push({
      path: 'media.understandImages',
      message: '视觉能力由宿主和当前模型探测，这个字段不再生效',
      severity: 'warn',
    })
  }

  // 已移除的字段要说话：静默忽略会让用户以为「配了却没生效」。
  const REMOVED_KEYS: Record<string, string> = {
    proactive: '主动搭话已移除，这个字段不再生效',
    sampling: '采样参数由 DSH 会话决定，卡片里的采样设置不再生效',
    greeting: 'greeting 从未生效，已移除',
    aliases: 'aliases 只对群聊有意义，本项目不支持群聊，已移除',
  }
  const KNOWN_KEYS = new Set(['id', 'name', 'description', 'prompt', 'reply', 'examples', 'media', 'progress'])
  for (const key of Object.keys(raw)) {
    const removed = REMOVED_KEYS[key]
    if (removed !== undefined) {
      warnings.push({ path: key, message: removed, severity: 'warn' })
      continue
    }
    if (!KNOWN_KEYS.has(key)) warnings.push({ path: key, message: '不认识的字段，已忽略', severity: 'warn' })
  }

  if (issues.length > 0) return { ok: false, issues }

  return {
    ok: true,
    warnings,
    card: {
      id: id as string,
      name: name as string,
      description: asString(raw.description) ?? '',
      prompt,
      reply,
      examples,
      media,
      progress,
    },
  }
}
