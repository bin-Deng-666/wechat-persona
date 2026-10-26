/**
 * 「收表情」：把聊天里收到的图片收进本地表情库。
 *
 * 为什么是两步（先存、再命名）而不是自动入库：
 * 自动入库会把聊天里所有图片都变成表情候选，模型下次可能把你随手发的截图当表情回给你。
 * 命名这一步是人工闸门——只有你说「收下，叫这个名字」才会真的进库。
 *
 * @module wechat-persona/persona/sticker-inbox
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { StickerLibrary } from './stickers.ts'

const EXTENSION_OF: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

/**
 * 一个 peer 的图片暂存区：每个聊天只留最近一张。
 *
 * 只留一张是刻意的：用户说「收下刚才那张」时指的是刚刚发的那张，
 * 留一堆历史图反而要猜。
 */
export class StickerInbox {
  private readonly root: string

  /**
   * @param root - `stickers-inbox/` 的绝对路径。
   */
  constructor(root: string) {
    this.root = root
  }

  /**
   * 存下一条入站图片。
   * @returns 落盘路径；格式不认识时 undefined。
   */
  async put(peerId: string, data: Uint8Array, mediaType: string): Promise<string | undefined> {
    const extension = EXTENSION_OF[mediaType]
    if (extension === undefined) return undefined
    const dir = this.dirOf(peerId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const target = join(dir, `latest${extension}`)
    const temp = `${target}.${String(process.pid)}.tmp`
    await writeFile(temp, data)
    await rename(temp, target)
    return target
  }

  /** 这个 peer 最近一张图片的路径；没有就 undefined。 */
  async latest(peerId: string): Promise<string | undefined> {
    for (const extension of Object.values(EXTENSION_OF)) {
      const file = join(this.dirOf(peerId), `latest${extension}`)
      try {
        await readFile(file)
        return file
      } catch {
        continue
      }
    }
    return undefined
  }

  /**
   * 把最近一张图收进表情库。
   *
   * @param peerId - 谁发的。
   * @param name - 表情名（模型之后写 `[表情:名字]` 用的就是它）。
   * @param library - 表情库。
   * @returns 收下的文件名；没有素材时 undefined。
   */
  async adopt(peerId: string, name: string, library: StickerLibrary): Promise<string | undefined> {
    const source = await this.latest(peerId)
    if (source === undefined) return undefined
    return await library.adopt(name, source)
  }

  private dirOf(peerId: string): string {
    return join(this.root, encodeURIComponent(peerId).replaceAll('%', '_'))
  }
}

/** 表情名合法化：不能带路径和方括号（否则标记解析会乱）。 */
export function normalizeStickerName(raw: string): string | undefined {
  const name = raw.trim().replace(/^\[|\]$/gu, '').replace(/[[\]/:：\\]/gu, '').trim()
  if (name === '' || name.length > 24) return undefined
  return name
}

/** 从 `/表情 收 名字` 的参数里取名字。 */
export function stickerNameFromArgs(args: readonly string[]): string | undefined {
  const tail = args.slice(1).join(' ').trim()
  return tail === '' ? undefined : normalizeStickerName(tail)
}

/** 图片扩展名（收表情时判断是否支持）。 */
export function extensionOf(mediaType: string): string | undefined {
  return EXTENSION_OF[mediaType]
}
