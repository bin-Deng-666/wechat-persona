/** 表情控制标记的纯文本协议；不访问磁盘或网络。 */
export interface StickerAnnotation { id: string; name?: string; description?: string; scenes?: string; ignore?: boolean }

/** 回复中的控制标记；只返回解析结果，落盘由素材库校验真实 ID。 */
export function extractStickerAnnotations(reply: string): { text: string; annotations: StickerAnnotation[] } {
  const annotations: StickerAnnotation[] = []
  const text = reply.replace(/\[(收录表情|忽略图片)[:：]([^\]\n]*)\]/gu, (_whole, kind: string, body: string) => {
    const [id = '', rawName = '', description = '', scenes = ''] = body.split('|').map(part => part.trim())
    if (!/^s_[a-f0-9]{20}$/u.test(id)) return ''
    if (kind === '忽略图片') annotations.push({ id, ignore: true })
    else {
      const name = normalizeStickerName(rawName)
      if (name !== undefined && description !== '' && scenes !== '') {
        annotations.push({ id, name, description: description.slice(0, 200), scenes: scenes.slice(0, 120) })
      }
    }
    return ''
  }).trim()
  return { text, annotations }
}

export function normalizeStickerName(raw: string): string | undefined {
  const name = raw.trim().normalize('NFC').replace(/^\[|\]$/gu, '').replace(/[[\]/:：\\]/gu, '').trim()
  return name === '' || name.length > 24 || /\s|[\x00-\x1f]/u.test(name) ? undefined : name
}

/** 回复里一段可发送的内容：文字或一张表情，顺序与原文一致。 */
export type StickerSegment = { kind: 'text'; value: string } | { kind: 'sticker'; value: string }

/**
 * 把回复切成有序的文字/表情片段。
 *
 * 发送端必须按这个顺序逐段发出，所以这里是唯一的分词实现：
 * 名字不合法（空、超长、含空格）时保留原文，避免把用户的字悄悄吃掉。
 */
export function splitStickerSegments(reply: string): StickerSegment[] {
  const segments: StickerSegment[] = []
  const pattern = /\[表情[:：]([^\]]*)\]/gu
  let start = 0
  for (const match of reply.matchAll(pattern)) {
    const name = normalizeStickerName(match[1] ?? '')
    if (name === undefined) continue
    const before = reply.slice(start, match.index).trim()
    if (before !== '') segments.push({ kind: 'text', value: before })
    segments.push({ kind: 'sticker', value: name })
    start = match.index + match[0].length
  }
  const rest = reply.slice(start).trim()
  if (rest !== '') segments.push({ kind: 'text', value: rest })
  return segments
}

export interface StickerToken { name: string; text: string }

/** 第一条表情及其前后的文字；没有表情时返回 undefined。 */
export function parseStickerToken(reply: string): StickerToken | undefined {
  const segments = splitStickerSegments(reply)
  const first = segments.findIndex(segment => segment.kind === 'sticker')
  if (first < 0) return undefined
  const sticker = segments[first] as { kind: 'sticker'; value: string }
  const text = segments.filter((segment, index) => index !== first && segment.kind === 'text')
    .map(segment => segment.value).join(' ').trim()
  return { name: sticker.value, text }
}

/** 一次回复里的全部表情标记；发送端要逐张发，不能只取第一张。 */
export function parseStickerTokens(reply: string): { names: string[]; text: string } {
  const segments = splitStickerSegments(reply)
  return {
    names: segments.filter(segment => segment.kind === 'sticker').map(segment => segment.value),
    text: segments.filter(segment => segment.kind === 'text').map(segment => segment.value).join(' ').trim(),
  }
}
