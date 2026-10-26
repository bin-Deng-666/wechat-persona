/**
 * 每个聊天自己的设置。
 *
 * 放在 `data/chats/<peerId>/settings.json`：清楚、可手改、可单独备份。
 * 缺字段一律回落默认值，所以旧文件不会因为新增字段而失效。
 *
 * 这里只存「这个聊天怎么对待」；人格卡本身存在 `personas/`，两者用 `personaId` 关联。
 *
 * @module wechat-persona/chat/settings
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ChatSettings {
  /** 用哪张人格卡；undefined 表示用全局默认。 */
  personaId?: string
  /** false = 这个聊天不回复（消息仍然会被读到，但不投递）。 */
  enabled: boolean
  /** 单条回复的字数上限；undefined 表示用卡片自己的值。 */
  maxChars?: number
  /** 切分粒度；undefined 表示用卡片自己的值。 */
  split?: 'paragraph' | 'sentence' | 'none'
}

/** 默认设置：启用、跟随全局人格、跟随卡片长度。 */
export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  enabled: true,
}

const MAX_CHARS_RANGE = { min: 20, max: 4_096 } as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把磁盘上的 JSON 收窄成设置；坏值逐项丢弃而不是整份作废。
 * @param raw - 解析后的 JSON。
 */
export function parseChatSettings(raw: unknown): ChatSettings {
  if (!isRecord(raw)) return { ...DEFAULT_CHAT_SETTINGS }
  const settings: ChatSettings = { ...DEFAULT_CHAT_SETTINGS }

  if (typeof raw['personaId'] === 'string' && raw['personaId'].trim() !== '') settings.personaId = raw['personaId'].trim()
  if (typeof raw['enabled'] === 'boolean') settings.enabled = raw['enabled']

  const maxChars = raw['maxChars']
  if (typeof maxChars === 'number' && Number.isFinite(maxChars)) {
    settings.maxChars = Math.round(Math.min(MAX_CHARS_RANGE.max, Math.max(MAX_CHARS_RANGE.min, maxChars)))
  }

  const split = raw['split']
  if (split === 'paragraph' || split === 'sentence' || split === 'none') settings.split = split

  return settings
}

/** 一个聊天的设置仓库。 */
export class ChatSettingsStore {
  private readonly root: string
  /** 缓存里带 mtime：文件被改过就重读，改完不必重启。 */
  private readonly cache = new Map<string, { settings: ChatSettings; mtimeMs: number }>()

  /**
   * @param root - `chats/` 目录的绝对路径。
   */
  constructor(root: string) {
    this.root = root
  }

  /**
   * 读一个聊天的设置；文件不存在返回默认值。
   * @param peerId - 微信用户 id。
   */
  async get(peerId: string): Promise<ChatSettings> {
    const file = this.fileOf(peerId)
    let mtimeMs = 0
    try {
      mtimeMs = (await stat(file)).mtimeMs
    } catch {
      // 没有文件 = 默认设置。
      const settings = { ...DEFAULT_CHAT_SETTINGS }
      this.cache.set(peerId, { settings, mtimeMs: 0 })
      return settings
    }
    const cached = this.cache.get(peerId)
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.settings
    try {
      const settings = parseChatSettings(JSON.parse(await readFile(file, 'utf8')) as unknown)
      this.cache.set(peerId, { settings, mtimeMs })
      return settings
    } catch {
      const settings = { ...DEFAULT_CHAT_SETTINGS }
      this.cache.set(peerId, { settings, mtimeMs })
      return settings
    }
  }

  /**
   * 写一个聊天的设置（原子写）。
   * @param peerId - 微信用户 id。
   * @param settings - 要保存的设置。
   */
  async save(peerId: string, settings: ChatSettings): Promise<ChatSettings> {
    const normalized = parseChatSettings(settings)
    const dir = join(this.root, this.dirOf(peerId))
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const target = this.fileOf(peerId)
    const temp = `${target}.${String(process.pid)}.tmp`
    // 目录名是转义过的，真实 peer id 存在文件里，listPeers 才能还原。
    await writeFile(temp, JSON.stringify({ peerId, ...normalized }, null, 2), 'utf8')
    await rename(temp, target)
    // 写入后把缓存丢掉，下次 get 会按新 mtime 重新读，避免缓存与磁盘不一致。
    this.cache.delete(peerId)
    return normalized
  }

  /**
   * 列出已知聊天（真实 peer id）。
   *
   * 目录名是转义过的，所以这里逐个读 `settings.json` 里的 `peerId`；
   * 没有这个字段的目录（手写的/旧版）按目录名返回。
   */
  async listPeers(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises')
    try {
      const entries = await readdir(this.root, { withFileTypes: true })
      const peers: string[] = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        try {
          const raw = JSON.parse(await readFile(join(this.root, entry.name, 'settings.json'), 'utf8')) as { peerId?: unknown }
          peers.push(typeof raw.peerId === 'string' && raw.peerId !== '' ? raw.peerId : entry.name)
        } catch {
          peers.push(entry.name)
        }
      }
      return peers
    } catch {
      return []
    }
  }

  /**
   * peerId 里有 `/`、`:` 这类字符，落盘时要转义成安全目录名。
   * 反解不需要——目录名只用于存储，真实 peer id 存在文件内容里的 key 上。
   */
  private dirOf(peerId: string): string {
    return encodeURIComponent(peerId).replaceAll('%', '_')
  }

  private fileOf(peerId: string): string {
    return join(this.root, this.dirOf(peerId), 'settings.json')
  }
}
