/**
 * 跨会话的「记住」。
 *
 * DSH 的会话历史只对同一段对话有效；`/new` 之后模型会失忆。这里给模型一个
 * 极窄的写入通道：回复里写 `[记住: 用户叫阿彬]`，通道把标记摘掉、存成一条事实，
 * 下一轮再以「你记得：…」注入回去。
 *
 * 为什么不让模型自己写文件：那需要它有工具、会挑文件、还得防止它把聊天记录
 * 整段抄进去。一个标记 + 一份人类可读的 JSON，是成本最低、最不容易失控的做法。
 *
 * @module wechat-persona/chat/memory
 */

import { readFile, rename, writeFile } from 'node:fs/promises'

/** 标记里最多记多少字。 */
export const MAX_FACT_CHARS = 120

/** 每个聊天最多保留多少条事实。 */
export const MAX_FACTS = 30

const MARKER = /\[记住[:：]\s*([^\]\n]+)\]/gu

export interface MemoryMarkerResult {
  /** 去掉标记之后的回复（照常发给用户）。 */
  text: string
  /** 这次要记下的事实。 */
  facts: string[]
}

/**
 * 从回复里摘出「记住」标记。
 *
 * 标记是给通道看的，用户不该看到；所以无论存不存得进去，都要从正文里删掉。
 * @param reply - 模型回复原文。
 */
export function extractMemoryMarkers(reply: string): MemoryMarkerResult {
  const facts: string[] = []
  const text = reply.replace(MARKER, (_whole, fact: string) => {
    const trimmed = fact.trim()
    if (trimmed !== '') facts.push(trimmed.slice(0, MAX_FACT_CHARS))
    return ''
  }).trim()
  return { text, facts }
}

/** `/记忆` 卡片里展示的一条。 */
export interface MemoryView {
  facts: readonly string[]
  /** 一共存了几条（可能超过展示条数）。 */
  total: number
}

/** 落盘的记忆表：`{ "<peerId>": ["事实", ...] }`。 */
export class PeerMemory {
  private readonly file: string
  private readonly values = new Map<string, string[]>()

  /**
   * @param file - `memories.json` 的绝对路径。
   */
  constructor(file: string) {
    this.file = file
  }

  /** 从磁盘读取；文件不存在或损坏都当作空表。 */
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown
      if (typeof raw !== 'object' || raw === null) return
      for (const [peerId, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue
        const facts = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        if (facts.length > 0) this.values.set(peerId, facts)
      }
    } catch {
      // 没有文件 / 坏了：当作空表。
    }
  }

  /** 某个聊天记住的事实。 */
  get(peerId: string): readonly string[] {
    return this.values.get(peerId) ?? []
  }

  /** 卡片展示用。 */
  view(peerId: string): MemoryView {
    const facts = this.get(peerId)
    return { facts, total: facts.length }
  }

  /**
   * 记下几条事实（去重、限量）。
   * @returns 实际新增了几条。
   */
  async remember(peerId: string, facts: readonly string[]): Promise<number> {
    if (facts.length === 0) return 0
    const current = [...(this.values.get(peerId) ?? [])]
    let added = 0
    for (const raw of facts) {
      const fact = raw.trim().slice(0, MAX_FACT_CHARS)
      if (fact === '' || current.includes(fact)) continue
      current.push(fact)
      added += 1
    }
    if (added === 0) return 0
    // 超量时丢最早的：记忆是「聊天印象」，最近说的更重要。
    const kept = current.slice(-MAX_FACTS)
    this.values.set(peerId, kept)
    await this.flush()
    return added
  }

  /** 清空某个聊天的记忆。 */
  async clear(peerId: string): Promise<void> {
    if (!this.values.has(peerId)) return
    this.values.delete(peerId)
    await this.flush()
  }

  /** 注入 prompt 的一行；空记忆返回 undefined。 */
  lineFor(peerId: string, limit = 200): string | undefined {
    const facts = this.get(peerId)
    if (facts.length === 0) return undefined
    const text = facts.join('；')
    return text.length <= limit ? text : `${text.slice(0, limit)}…`
  }

  /** 落盘（原子写）。 */
  async flush(): Promise<void> {
    try {
      const temp = `${this.file}.${String(process.pid)}.tmp`
      await writeFile(temp, JSON.stringify(Object.fromEntries(this.values), null, 2), 'utf8')
      await rename(temp, this.file)
    } catch {
      // 写不进去不影响这一轮；下次 remember 会再试。
    }
  }
}
