/**
 * 长文本切分。
 *
 * 传输层对超长 body 是**拒绝**而不是截断，而微信没有重放——所以一条超长回答必须切成几条
 * 发出去，而不是整条丢掉。切分优先段落，其次换行，再次句子；代码块不留在切口中。
 *
 * @module wechat-persona/bridge/text
 */

export type SplitMode = 'paragraph' | 'sentence' | 'none'

const FENCE = '```'
const SENTENCE_END = /(?<=[。！？!?…；;])/u

/** 把文本按段落切开，保留空行语义。 */
function paragraphs(text: string): string[] {
  return text.split(/\n{2,}/u).map(part => part.trim()).filter(part => part !== '')
}

/** 把一段按句末标点切开。 */
function sentences(text: string): string[] {
  return text.split(SENTENCE_END).map(part => part.trim()).filter(part => part !== '')
}

/**
 * 把超长单元硬切成不超过 `maxChars` 的片段。
 *
 * 只有在找不到任何自然边界时才用它——一句话本身超过上限，没有更好的选择。
 */
function hardCut(text: string, maxChars: number): string[] {
  const out: string[] = []
  for (let index = 0; index < text.length; index += maxChars) {
    out.push(text.slice(index, index + maxChars))
  }
  return out
}

/**
 * 把一堆单元按上限打包成片段。
 *
 * 超长单元优先在句子边界上切，只有一句话本身超过上限时才硬切——
 * 按字数硬切中文会把词切开，读起来像乱码。
 */
function pack(units: readonly string[], maxChars: number, separator: string): string[] {
  const out: string[] = []
  let current = ''

  const flush = (): void => {
    if (current.trim() !== '') out.push(current.trim())
    current = ''
  }

  for (const unit of units) {
    if (unit.length > maxChars) {
      flush()
      const inner = sentences(unit)
      if (inner.length <= 1) out.push(...hardCut(unit, maxChars))
      else out.push(...pack(inner, maxChars, ''))
      continue
    }
    const candidate = current === '' ? unit : `${current}${separator}${unit}`
    if (candidate.length > maxChars) {
      flush()
      current = unit
      continue
    }
    current = candidate
  }
  flush()
  return out
}

/**
 * 切分一条回复。
 *
 * @param text - 原始回复。
 * @param maxChars - 单条上限（字符数）。
 * @param mode - 切分粒度；`none` 表示不切（调用方自己承担被拒的风险）。
 * @returns 至少一条文本；空输入返回空数组。
 */
export function splitText(text: string, maxChars: number, mode: SplitMode = 'paragraph'): string[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  if (mode === 'none' || maxChars <= 0 || trimmed.length <= maxChars) return [trimmed]

  const units = mode === 'sentence' ? sentences(trimmed) : paragraphs(trimmed)
  return balanceFences(pack(units, maxChars, mode === 'sentence' ? '' : '\n\n'))
}
/**
 * 保证跨片段时每个片段的代码块都闭合。
 *
 * 状态化处理：一片里有奇数个 ``` 就从这里切开，在末尾补闭合，并让下一片以同一个
 * 语言标记重新打开。不做这一步，切口之后的内容在微信里就是一堆裸文本。
 *
 * @param chunks - 原始片段。
 * @returns 闭合良好的片段；空片段被丢掉。
 */
function balanceFences(chunks: readonly string[]): string[] {
  const out: string[] = []
  // 当前仍处于哪个语言的代码块里；null 表示不在代码块里。
  let open: string | null = null

  for (const raw of chunks) {
    const chunk: string = open === null ? raw : `${FENCE}${open}\n${raw}`
    const fences = chunk.split(FENCE).length - 1
    if (fences % 2 === 1) {
      const lastOpen = chunk.lastIndexOf(FENCE)
      const lang: string = chunk.slice(lastOpen + FENCE.length).split('\n', 1)[0]?.trim() ?? ''
      const closed = `${chunk}\n${FENCE}`
      if (closed.trim() !== '') out.push(closed)
      open = lang
    } else {
      if (chunk.trim() !== '') out.push(chunk)
      open = null
    }
  }

  return out
}

/** 位置标记：`[位置:31.23,121.47,外滩]`（纬度在前）。 */
const LOCATION = /\[位置[:：]\s*(-?\d{1,3}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)\s*(?:[,，]\s*([^\]\n]{1,40}))?\]/gu

/**
 * 把位置标记换成一条带地图链接的文本。
 *
 * 协议里没有「位置消息」这种消息项（只有文本/图片/语音/文件/视频），
 * 所以「发定位」只能是：名字 + 一条地图链接。微信客户端会把链接变成可点的。
 *
 * @param text - 模型回复。
 * @returns 展开后的文本；没有标记时原样返回。
 */
export function expandLocationTokens(text: string): string {
  return text.replace(LOCATION, (_whole, lat: string, lng: string, name?: string) => {
    const label = name?.trim() ?? ''
    const query = label === '' ? `${lat},${lng}` : `${label} ${lat},${lng}`
    const url = `https://maps.apple.com/?ll=${encodeURIComponent(lat)},${encodeURIComponent(lng)}&q=${encodeURIComponent(query)}`
    return `${label === '' ? '位置' : `📍 ${label}`}\n${url}`
  })
}
