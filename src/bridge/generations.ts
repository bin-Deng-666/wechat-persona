/**
 * 每个聊天的「对话代次」。
 *
 * 会话 id 是 peer 的纯函数，所以「重新开始一段对话」不能改 peers，只能给 id 加代次：
 * `channel-persona-<peer>` → `channel-persona-<peer>~g1`。
 * 代次必须落盘，否则重启后会回到旧会话——用户以为开了新对话，其实接上了旧上下文。
 *
 * @module wechat-persona/bridge/generations
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export class PeerGenerations {
  private readonly file: string
  private cache: Record<string, number> | undefined

  /**
   * @param file - JSON 文件路径，形如 `<dataDir>/generations.json`。
   */
  constructor(file: string) {
    this.file = file
  }

  private async load(): Promise<Record<string, number>> {
    if (this.cache !== undefined) return this.cache
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, unknown>
      const out: Record<string, number> = {}
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out[key] = value
      }
      this.cache = out
      return out
    } catch {
      this.cache = {}
      return this.cache
    }
  }

  /** 当前代次；没记录过是 0。 */
  async get(peerId: string): Promise<number> {
    return (await this.load())[peerId] ?? 0
  }

  /** 代次 +1 并落盘，返回新代次。 */
  async bump(peerId: string): Promise<number> {
    const all = await this.load()
    const next = (all[peerId] ?? 0) + 1
    all[peerId] = next
    await this.save(all)
    return next
  }

  private async save(all: Record<string, number>): Promise<void> {
    this.cache = all
    const temp = `${this.file}.${String(process.pid)}.tmp`
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dirname(this.file), { recursive: true })
    // 原子写：写到一半崩掉不能留下半个 JSON，否则下次读到空对象、代次全丢。
    await writeFile(temp, JSON.stringify(all, null, 2), 'utf8')
    await rename(temp, this.file)
  }
}
