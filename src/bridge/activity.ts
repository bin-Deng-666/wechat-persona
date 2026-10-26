/**
 * 每个 peer 最后一次说话的时间（落盘）。
 *
 * 用于聊天列表和最近活跃状态展示。写盘节流到 5 秒一次，
 * 避免每条消息都重写文件。
 *
 * @module wechat-persona/bridge/activity
 */

import { readFile, rename, writeFile } from 'node:fs/promises'

/** 通道用到的活跃时间接口；实现可以是内存的，也可以是落盘的。 */
export interface ActivityStore {
  /** 读最后活跃时间（毫秒）。 */
  get(peerId: string): number | undefined
  /** 记一次活跃。 */
  touch(peerId: string, at: number): void
  /** 已知 peer。 */
  peers(): readonly string[]
  /** 从磁盘加载（可选）。 */
  load?(): Promise<void>
  /** 把挂起的写落盘。 */
  flush?(): Promise<void>
}

const FLUSH_INTERVAL_MS = 5_000

/** 落盘的活跃时间表。 */
export class PeerActivity implements ActivityStore {
  private readonly file: string
  private readonly values = new Map<string, number>()
  private timer: NodeJS.Timeout | undefined
  private writing = false

  /**
   * @param file - `last-seen.json` 的绝对路径。
   */
  constructor(file: string) {
    this.file = file
  }

  /** 从磁盘读取；文件不存在或损坏都当作空表（活跃时间丢了不是故障）。 */
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown
      if (typeof raw !== 'object' || raw === null) return
      for (const [peerId, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) this.values.set(peerId, value)
      }
    } catch {
      // 首次运行没有文件；损坏就重来。
    }
  }

  get(peerId: string): number | undefined {
    return this.values.get(peerId)
  }

  touch(peerId: string, at: number): void {
    this.values.set(peerId, at)
    this.schedule()
  }

  peers(): readonly string[] {
    return [...this.values.keys()]
  }

  private schedule(): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, FLUSH_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** 落盘（原子写）。并发调用合并成一次。 */
  async flush(): Promise<void> {
    if (this.writing) return
    this.writing = true
    try {
      const temp = `${this.file}.${String(process.pid)}.tmp`
      await writeFile(temp, JSON.stringify(Object.fromEntries(this.values), null, 2), 'utf8')
      await rename(temp, this.file)
    } catch {
      // 写不进去也不影响这一轮；下次活跃会再试。
    } finally {
      this.writing = false
    }
  }
}
