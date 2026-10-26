/**
 * 会话分组：把本插件的会话挂到宿主工作区，避免在 GUI 里落进「未分组」。
 *
 * DSH 的会话列表按工作区分组；只有「被登记进某个工作区、且会话头部记录的 cwd
 * 等于该工作区路径」的会话才会显示在分组下，其余都归入「未分组」。本插件的会话
 * 有自己的 cwd，所以启动时补挂一次、之后每轮结束时补挂一次。
 *
 * 结构化声明而非导入：精简宿主可能没有工作区注册表，缺了要能继续跑会话，
 * 而不是让插件加载失败。
 *
 * @module wechat-persona/dsh/workspace
 */

import { SESSION_ID_PREFIX } from './sessions.ts'

/** 工作区实体里我们用到的部分。 */
export interface WorkspaceLike {
  readonly path: string
  /** 把一个会话登记进这个工作区；头部 cwd 必须与工作区路径一致。 */
  attachSession(sessionId: string): Promise<void>
}

/** `ctx.workspaceRegistry` 里我们用到的部分。 */
export interface WorkspaceRegistryLike {
  /** 为已存在的目录创建或复用一个工作区；同一路径重复调用返回同一实体。 */
  create(path: string, title?: string): Promise<WorkspaceLike>
}

/** `ctx.sessionPersistence` 里我们用到的部分。 */
export interface SessionPersistenceLike {
  list(): Promise<readonly { header: { id: string; cwd?: string } }[]>
}

export interface WorkspaceGrouperOptions {
  registry: WorkspaceRegistryLike | undefined
  persistence: SessionPersistenceLike | undefined
  /** 本插件会话统一的工作目录；工作区路径必须与它一致才能挂载。 */
  cwd: string
  /** 新建工作区时用的标题；已存在的工作区标题不变。 */
  title: string
  report?: (line: string, detail?: unknown) => void
}

/**
 * 把一个插件的会话归入工作区。
 *
 * 只碰本插件自己的会话（id 前缀过滤），且只在会话 cwd 与工作区路径一致时才挂载，
 * 失败会报告并留待下次重试，不会影响会话本身。
 */
export class WorkspaceGrouper {
  private readonly options: WorkspaceGrouperOptions
  /** 已成功挂载的会话，避免重复调用。 */
  private readonly grouped = new Set<string>()
  private workspace: Promise<WorkspaceLike> | undefined

  constructor(options: WorkspaceGrouperOptions) {
    this.options = options
  }

  /** 宿主没有工作区注册表时不做任何事（headless 等组合）。 */
  get available(): boolean {
    return this.options.registry !== undefined
  }

  /**
   * 挂载一个会话；可重复调用。
   * @param sessionId - 会话 id；非本插件前缀的会被忽略。
   * @returns 是否已经登记进工作区。
   */
  async attach(sessionId: string): Promise<boolean> {
    const registry = this.options.registry
    if (registry === undefined || this.grouped.has(sessionId)) return this.grouped.has(sessionId)
    if (!sessionId.startsWith(SESSION_ID_PREFIX)) return false
    try {
      // create 对同一规范路径幂等，所以不需要先查列表。
      this.workspace ??= registry.create(this.options.cwd, this.options.title)
      const workspace = await this.workspace
      await workspace.attachSession(sessionId)
      this.grouped.add(sessionId)
      return true
    } catch (error) {
      // 失败可能只是「会话头部还没落盘」；清掉缓存的工作区句柄，下次重试。
      this.workspace = undefined
      this.options.report?.('会话未能归入工作区', { sessionId, error: String(error) })
      return false
    }
  }

  /**
   * 扫描已持久化的会话，把属于本插件、cwd 匹配的会话一次性补齐。
   * 用于插件启动：把上一轮运行留下的会话从「未分组」移进工作区。
   * @returns 本次补齐的会话数。
   */
  async sweep(): Promise<number> {
    const persistence = this.options.persistence
    if (persistence === undefined || this.options.registry === undefined) return 0
    let grouped = 0
    try {
      for (const snapshot of await persistence.list()) {
        const { id, cwd } = snapshot.header
        if (cwd !== this.options.cwd || this.grouped.has(id)) continue
        if (await this.attach(id)) grouped += 1
      }
    } catch (error) {
      this.options.report?.('扫描已有会话分组失败', { error: String(error) })
    }
    return grouped
  }
}
