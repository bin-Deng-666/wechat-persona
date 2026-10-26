/**
 * 微信 peer ⇄ DSH 会话。
 *
 * 一个 peer 一个会话，且句柄要**留着**：registry 对同一个 id 第二次 `create` 会抛，
 * 而 `followup` 打到已经 dispose 的 agent 上会「接受然后丢掉」——表现为通道安静地不再回话，
 * 而不是报错。所以每次投递前都要用 registry 确认它还活着。
 *
 * @module wechat-persona/bridge/session
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** 本通道拥有的会话 id 前缀，与其他插件的区分开。 */
export const SESSION_ID_PREFIX = 'channel-persona-'

/**
 * 一个 peer 的会话 id。
 *
 * 纯函数：同一个 peer 在任何一次重启后都落到同一个会话，从而接上已持久化的历史。
 * @param peerId - 微信用户 id。
 */
export function sessionIdFor(peerId: string): SessionId {
  // 会话 id 是路径片段，必须只含安全字符；其余用 `-` 替掉并保证唯一性（peer id 本身唯一）。
  const safe = peerId.replace(/[^A-Za-z0-9_-]/gu, '-')
  return `${SESSION_ID_PREFIX}${safe}` as SessionId
}

/** registry 返回的句柄，只取我们用得到的部分。 */
export interface AgentHandleLike {
  readonly agent: {
    readonly id: SessionId
    /** 把一条消息排成下一轮并唤醒循环。 */
    followup(message: never): void
  }
  /** 停循环、反注册、释放写租约。 */
  dispose(): Promise<void>
}

/** `ctx.agents` 中我们用到的部分。 */
export interface AgentRegistryLike {
  create(options: {
    sessionId: SessionId
    agentOptions?: { provider?: string; model?: string }
    meta?: { cwd?: string }
    signal?: AbortSignal
  }): Promise<AgentHandleLike>
  resume(options: {
    resumeSessionId: SessionId
    agentOptions?: { provider?: string; model?: string }
  }): Promise<AgentHandleLike>
  get(sessionId: SessionId): { readonly id: SessionId } | undefined
}

export interface PeerSessionsOptions {
  registry: AgentRegistryLike
  /** 新建会话记录的工作目录（绝对路径，创建后不可改）。 */
  cwd: string
  /** 本通道创建/恢复的会话统一使用的模型。 */
  sessionOptions?: { provider?: string; model?: string }
  /** 探测持久化会话是否已存在；缺省视为不存在。 */
  sessionExists?: (sessionId: SessionId) => Promise<boolean>
  /** 诊断出口。 */
  onError?: (error: unknown, peerId: string) => void
}

export class PeerSessions {
  private readonly options: PeerSessionsOptions
  private readonly live = new Map<string, AgentHandleLike>()

  constructor(options: PeerSessionsOptions) {
    this.options = options
  }

  /**
   * 取（必要时建）一个 peer 的 agent。
   *
   * 顺序：内存句柄 → registry 里已被别的 owner 启动的会话（直接借用，不 dispose）
   * → 已持久化的会话（resume）→ 新建。
   */
  async acquire(peerId: string): Promise<AgentHandleLike> {
    const existing = this.live.get(peerId)
    if (existing !== undefined) return existing

    const sessionId = sessionIdFor(peerId)
    const registry = this.options.registry

    // 用 `get` 而不是只信本地表：会话可能被 GUI 或上一轮运行启动着。
    const running = registry.get(sessionId)
    if (running !== undefined) {
      const adopted: AgentHandleLike = {
        agent: running as AgentHandleLike['agent'],
        // 借用别人的 agent，绝不能在这里 dispose——那会把 GUI 的会话也一起关掉。
        dispose: async () => {},
      }
      this.live.set(peerId, adopted)
      return adopted
    }

    const options = this.options.sessionOptions === undefined ? {} : { agentOptions: this.options.sessionOptions }
    let handle: AgentHandleLike
    if ((await this.options.sessionExists?.(sessionId)) === true) {
      handle = await registry.resume({ resumeSessionId: sessionId, ...options })
    } else {
      try {
        handle = await registry.create({ sessionId, meta: { cwd: this.options.cwd }, ...options })
      } catch (error) {
        // 竞态：并发拿到同一个 peer 时 `create` 会因 id 已存在而抛。再 `get` 一次。
        const raced = registry.get(sessionId)
        if (raced === undefined) throw error
        handle = { agent: raced as AgentHandleLike['agent'], dispose: async () => {} }
      }
    }

    this.live.set(peerId, handle)
    return handle
  }

  /**
   * 投递一条消息。
   *
   * 句柄可能已经死了（agent 被 GUI 关掉、或被上一轮运行 dispose）。
   * `followup` 打到死 agent 上是「接受然后丢掉」，所以这里先问 registry 它还在不在，
   * 不在就丢掉句柄重建一次——这是唯一能在投递路径上发现静默丢消息的地方。
   */
  async deliver(peerId: string, message: never): Promise<void> {
    const cached = this.live.get(peerId)
    if (cached !== undefined && this.options.registry.get(cached.agent.id) === undefined) {
      this.live.delete(peerId)
    }
    const handle = await this.acquire(peerId)
    handle.agent.followup(message)
  }

  /** 释放一个 peer 的句柄（不 dispose 借用的）。 */
  async release(peerId: string): Promise<void> {
    const handle = this.live.get(peerId)
    this.live.delete(peerId)
    if (handle !== undefined) await handle.dispose()
  }

  /** 关掉本通道自己创建的所有 agent。 */
  async disposeAll(): Promise<void> {
    const handles = [...this.live.values()]
    this.live.clear()
    for (const handle of handles) {
      try {
        await handle.dispose()
      } catch (error) {
        this.options.onError?.(error, 'dispose')
      }
    }
  }

  /** 当前持有的 peer，供诊断与 GUI 展示。 */
  peers(): readonly string[] {
    return [...this.live.keys()]
  }
}
