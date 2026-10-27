/** 每个联系人的聊天设置。哈希目录隔离联系人，旧目录仅在身份匹配时读取。 */
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicJson } from '../storage/atomic.ts'
import { withFileLock } from '../storage/lock.ts'

export interface ChatSettings {
  personaId?: string
  enabled: boolean
  /** 兼容已保存的发送参数；当前菜单不提供这些设置。 */
  maxChars?: number
  split?: 'paragraph' | 'sentence' | 'none'
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = { enabled: true }
const MAX_CHARS_RANGE = { min: 20, max: 4_096 } as const
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 字段不合法时回落该字段的默认值；磁盘文档损坏则由读取层报错并保留原件。 */
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

interface CachedSettings { settings: ChatSettings; mtimeMs: number; file: string }

export class ChatSettingsStore {
  private readonly root: string
  private readonly cache = new Map<string, CachedSettings>()
  constructor(root: string) { this.root = root }

  private directory(peerId: string): string {
    if (!peerId) throw new Error('聊天联系人不能为空')
    return createHash('sha256').update(peerId).digest('hex')
  }
  private fileOf(peerId: string): string { return join(this.root, this.directory(peerId), 'settings.json') }
  private legacyDirectory(peerId: string): string | undefined {
    const name = encodeURIComponent(peerId).replaceAll('%', '_')
    return name !== '' && name !== '.' && name !== '..' ? name : undefined
  }

  /** 旧转义目录可能碰撞，只能读取确实属于当前联系人的文档。 */
  private async read(peerId: string, file: string, legacy: boolean): Promise<ChatSettings | undefined> {
    let info
    try { info = await stat(file) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const cached = this.cache.get(peerId)
    if (cached?.file === file && cached.mtimeMs === info.mtimeMs) return cached.settings
    let raw: unknown
    try { raw = JSON.parse(await readFile(file, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('聊天设置无法读取或解析，原文件已保留', { cause: error })
    }
    if (!isRecord(raw)) throw new Error('聊天设置格式错误，原文件已保留')
    const legacyWithoutId = legacy && raw.peerId === undefined && /^[a-zA-Z0-9_-]+$/u.test(peerId)
    if (raw.peerId !== peerId && !legacyWithoutId) {
      if (legacy) return undefined
      throw new Error('聊天设置的联系人不匹配，原文件已保留')
    }
    const settings = parseChatSettings(raw)
    this.cache.set(peerId, { settings, mtimeMs: info.mtimeMs, file })
    return settings
  }

  async get(peerId: string): Promise<ChatSettings> {
    const current = await this.read(peerId, this.fileOf(peerId), false)
    if (current !== undefined) return current
    const legacy = this.legacyDirectory(peerId)
    if (legacy !== undefined && legacy !== this.directory(peerId)) {
      const previous = await this.read(peerId, join(this.root, legacy, 'settings.json'), true)
      if (previous !== undefined) return previous
    }
    return { ...DEFAULT_CHAT_SETTINGS }
  }

  async save(peerId: string, settings: ChatSettings): Promise<ChatSettings> {
    return await this.update(peerId, () => settings)
  }

  /** 仅在新哈希目录写入；读取旧值后提交新快照，旧文件保留供备份和核对。 */
  async update(peerId: string, change: (current: ChatSettings) => ChatSettings): Promise<ChatSettings> {
    return await withFileLock(this.fileOf(peerId), async () => {
      this.cache.delete(peerId)
      const normalized = parseChatSettings(change(await this.get(peerId)))
      await atomicJson(this.fileOf(peerId), { peerId, ...normalized })
      this.cache.delete(peerId)
      return normalized
    })
  }

  async listPeers(): Promise<string[]> {
    let entries
    try { entries = await readdir(this.root, { withFileTypes: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const peers = new Set<string>()
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const raw: unknown = JSON.parse(await readFile(join(this.root, entry.name, 'settings.json'), 'utf8'))
        if (!isRecord(raw)) continue
        const peer = typeof raw.peerId === 'string' && raw.peerId !== '' ? raw.peerId
          : raw.peerId === undefined && /^[a-zA-Z0-9_-]+$/u.test(entry.name) ? entry.name : undefined
        if (peer && (entry.name === this.directory(peer) || entry.name === this.legacyDirectory(peer))) peers.add(peer)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      }
    }
    return [...peers].sort()
  }
}
