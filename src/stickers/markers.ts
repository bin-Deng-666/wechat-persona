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

export interface StickerToken { name: string; text: string }
export function parseStickerToken(reply: string): StickerToken | undefined {
  const match = /\[表情[:：]\s*([^\]\s]{1,24})\s*\]/u.exec(reply)
  if (match?.[1] === undefined) return undefined
  return { name: match[1], text: reply.replace(/\[表情[:：][^\]]*\]/gu, '').trim() }
}

/** 一次回复里的全部表情标记；发送端要逐张发，不能只取第一张。 */
export function parseStickerTokens(reply: string): { names: string[]; text: string } {
  const names: string[] = []
  const text = reply.replace(/\[表情[:：]\s*([^\]\s]{1,24})\s*\]/gu, (_whole, name: string) => {
    names.push(name)
    return ''
  }).trim()
  return { names, text }
}
