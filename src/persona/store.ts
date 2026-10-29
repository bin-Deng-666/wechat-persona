/**
 * 人格卡的加载与热更新。
 *
 * 目录即人格：`<root>/personas/<id>/persona.json`。这里只做 IO 与缓存，
 * 校验交给 `parsePersonaCard`，渲染交给 `buildSystemPrompt`。
 *
 * 加载策略：
 * - 启动扫全量；单张坏卡不阻塞，记进 `broken` 供 GUI 标红
 * - 每张卡按 mtime 判断是否需要重新解析（编辑保存后下一轮生效，不重启）
 * - 目录被删 = 人格消失；调用方负责回落到默认人格
 *
 * @module wechat-persona/persona/store
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { parsePersonaCard, type CardIssue, type PersonaCard } from './card.ts'

export interface LoadedPersona {
  card: PersonaCard
  dir: string
  /** `persona.json` 的 mtime，用于判断是否需要重新解析。 */
  mtimeMs: number
  warnings: CardIssue[]
}

export interface BrokenPersona {
  id: string
  dir: string
  issues: CardIssue[]
}

export interface PersonaSnapshot {
  personas: Map<string, LoadedPersona>
  broken: BrokenPersona[]
}

/** 内置兜底人格：目录里一张卡都没有时也能跑起来。 */
export const BUILTIN_DEFAULT: PersonaCard = {
  id: 'default',
  name: '小助手',
  description: '内置兜底人格：没有可用人格卡时使用',
  prompt: {
    identity: '你是一个住在微信里的助手，说话直接、简短、不客套。你可以读写这台电脑上的文件、执行命令、查资料。',
    style: ['一般 1-3 句', '不用「作为 AI」这类措辞', '干活时先说一句要做什么'],
    rules: ['不确定就直说', '改文件前说清改哪里'],
    forbidden: ['不复述对方原话', '不编造执行结果'],
  },
  reply: { maxChars: 120, split: 'paragraph' },
  examples: [],
  media: { sendStickers: true },
  // 直接、简短、不客套；只说在弄，不承诺时间，也不假装知道还剩多少。
  // 10 条 = 一轮配额（20 秒一句、200 秒窗口），一轮内不重样。
  progress: [
    '在弄，稍等。',
    '这步慢，在等。',
    '卡了一下，重试。',
    '换条路试。',
    '还没完，继续。',
    '在理，有点绕。',
    '快好了。',
    '差最后一点。',
    '在核对。',
    '有结果就说。',
  ],
}

/**
 * 首次启动时把内置默认人格落盘。
 *
 * 不落盘的话 `defaultPersona: default` 指向一张不存在的卡，用户看到的是
 * 「列表里没有人格卡、但回复又有人设」这种自相矛盾的状态。
 *
 * @param root - `personas/` 目录。
 * @returns 是否真的写了一张新卡。
 */
export async function seedDefaultPersona(root: string): Promise<boolean> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const file = join(root, 'default', 'persona.json')
  try {
    await stat(file)
    return false
  } catch {
    // 没有就写。
  }
  try {
    await mkdir(join(root, 'default'), { recursive: true })
    await writeFile(file, JSON.stringify(BUILTIN_DEFAULT, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

export class PersonaStore {
  readonly root: string
  private cache = new Map<string, LoadedPersona>()

  /**
   * @param root - `personas/` 目录的绝对路径。
   */
  constructor(root: string) {
    this.root = root
  }

  /**
   * 扫一遍目录，返回最新快照。
   *
   * 失败的卡不会抛异常：它们出现在 `broken` 里，调用方决定怎么提示。
   * 读目录本身失败（权限、路径不存在）时抛异常——那是配置错误，不是数据错误。
   */
  async snapshot(): Promise<PersonaSnapshot> {
    const personas = new Map<string, LoadedPersona>()
    const broken: BrokenPersona[] = []
    let entries: string[]

    try {
      entries = await readdir(this.root)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // 首次启动目录还不存在是正常状态，不是错误。
      if (code === 'ENOENT') return { personas, broken }
      throw error
    }

    for (const id of entries) {
      const dir = join(this.root, id)
      const file = join(dir, 'persona.json')
      let mtimeMs: number
      try {
        const info = await stat(file)
        if (!info.isFile()) continue
        mtimeMs = info.mtimeMs
      } catch {
        // 目录里没有 persona.json：不是人格目录，跳过。
        continue
      }

      const cached = this.cache.get(id)
      if (cached !== undefined && cached.mtimeMs === mtimeMs) {
        personas.set(id, cached)
        continue
      }

      let raw: unknown
      try {
        raw = JSON.parse(await readFile(file, 'utf8')) as unknown
      } catch (error) {
        broken.push({
          id,
          dir,
          issues: [{ path: '', message: `读取或解析失败：${String(error)}`, severity: 'error' }],
        })
        this.cache.delete(id)
        continue
      }

      const result = parsePersonaCard(raw, id)
      if (!result.ok) {
        broken.push({ id, dir, issues: result.issues })
        this.cache.delete(id)
        continue
      }

      const loaded: LoadedPersona = { card: result.card, dir, mtimeMs, warnings: result.warnings }
      this.cache.set(id, loaded)
      personas.set(id, loaded)
    }

    // 目录里已删除的卡要清出缓存，否则删了人格还在。
    for (const id of [...this.cache.keys()]) {
      if (!personas.has(id)) this.cache.delete(id)
    }

    return { personas, broken }
  }

  /**
   * 取一张卡；不存在时回落到内置默认。
   *
   * @param id - 人格 id。
   * @param snapshot - 已加载的快照，避免重复扫盘。
   */
  static resolve(id: string, snapshot: PersonaSnapshot): PersonaCard {
    return snapshot.personas.get(id)?.card ?? snapshot.personas.get('default')?.card ?? BUILTIN_DEFAULT
  }
}
