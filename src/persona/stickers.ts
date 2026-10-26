/**
 * 表情库与「回复里点歌式地要一张表情」。
 *
 * 约定：模型在回复末尾写 `[表情:名字]`，通道把它换成本地 `stickers/<名字>.<ext>` 的图片发出去。
 * 名字对不上、没有表情库、发送失败，都退化成「把这句文字照常发出去」——
 * 宁可少一张表情，也不能让整条回复消失。
 *
 * @module wechat-persona/persona/stickers
 */

import { readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'

/** 支持的表情文件扩展名。 */
const STICKER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

/** 从回复里找表情标记。 */
const TOKEN_PATTERN = /\[表情[:：]\s*([^\]\s]{1,24})\s*\]/u

export interface StickerToken {
  /** 标记里的名字。 */
  name: string
  /** 去掉标记之后的文字（可能为空）。 */
  text: string
}

/**
 * 抽出回复里的表情标记。
 * @param reply - 模型回复。
 * @returns 有标记时返回名字与剩余文字；没有返回 undefined。
 */
export function parseStickerToken(reply: string): StickerToken | undefined {
  const match = TOKEN_PATTERN.exec(reply)
  if (match === null) return undefined
  const name = match[1]
  if (name === undefined || name === '') return undefined
  const text = `${reply.slice(0, match.index)}${reply.slice(match.index + match[0].length)}`.trim()
  return { name, text }
}

/** 一个本地表情库。 */
export class StickerLibrary {
  private readonly root: string
  private index: Map<string, string> | undefined

  /**
   * @param root - `stickers/` 目录的绝对路径。
   */
  constructor(root: string) {
    this.root = root
  }

  /** 扫目录建索引（名字 → 绝对路径），首次调用后缓存。 */
  async load(): Promise<void> {
    if (this.index !== undefined) return
    const index = new Map<string, string>()
    try {
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        const extension = extname(entry.name).toLowerCase()
        if (!STICKER_EXTENSIONS.has(extension)) continue
        // macOS 的文件名可能是 NFD（分解形式），统一成 NFC，
        // 否则模型写的名字与磁盘上的名字看着一样却不相等。
        index.set(entry.name.slice(0, -extension.length).normalize('NFC'), join(this.root, entry.name))
      }
    } catch {
      // 没有表情目录是正常状态：功能不可用，但不报错。
    }
    this.index = index
  }

  /** 名字对应的文件路径。 */
  async find(name: string): Promise<string | undefined> {
    await this.load()
    return this.index?.get(name.normalize('NFC'))
  }

  /** 已知表情名（GUI/诊断用）。 */
  async names(): Promise<string[]> {
    await this.load()
    return [...(this.index?.keys() ?? [])]
  }
}
