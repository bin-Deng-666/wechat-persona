/**
 * 微信 peer ⇄ DSH 会话。
 *
 * 一个 peer 一个会话，且句柄要**留着**：registry 对同一个 id 第二次 `create` 会抛，
 * 而 `followup` 打到已经 dispose 的 agent 上会「接受然后丢掉」——表现为通道安静地不再回话，
 * 而不是报错。所以每次投递前都要用 registry 确认它还活着。
 *
 * @module wechat-persona/dsh/sessions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** 本通道拥有的会话 id 前缀，与其他插件的区分开。 */
export const SESSION_ID_PREFIX = 'channel-persona-'

/**
 * 一个 peer 的会话 id。
 *
 * 纯函数：同一个 peer 在任何一次重启后都落到同一个会话，从而接上已持久化的历史。
 * @param peerId - 微信用户 id。
 */
export function sessionIdFor(peerId: string, generation = 0): SessionId {
  // 会话 id 是路径片段，必须只含安全字符；其余用 `-` 替掉并保证唯一性（peer id 本身唯一）。
  const safe = peerId.replace(/[^A-Za-z0-9_-]/gu, '-')
  // 代次 0 不加后缀，保持旧会话 id 不变（升级后能接上历史）。
  return (generation <= 0 ? `${SESSION_ID_PREFIX}${safe}` : `${SESSION_ID_PREFIX}${safe}~g${String(generation)}`) as SessionId
}

/** registry 返回的句柄，只取我们用得到的部分。 */
export interface AgentHandleLike {
  readonly agent: {
    readonly id: SessionId
    /** 宿主的会话作用域，注册本会话的系统提示词与监听器。 */
    readonly ctx?: Context
    /** 把一条消息排成下一轮并唤醒循环。 */
    followup(message: never): void
    /** 当前是否在跑一轮，GUI 的停止按钮看的也是它。 */
    readonly status?: 'idle' | 'running'
    /**
     * 打断当前这一轮。
     *
     * `keepInbox` 为 false（默认）时连排队未处理的消息一起丢掉；
     * 微信里用户说「停」通常意味着「现在这些都不要了」，所以用默认值。
     */
    cancel?(cause: { kind: 'user' }, options?: { keepInbox?: boolean }): void
    /**
     * 持久化会话对象；真实 registry 会给，测试里的结构化句柄可能没有。
     * 权限预设只能记在它上面。
     */
    readonly session?: unknown
  }
  /** 停循环、反注册、释放写租约。 */
  dispose(): Promise<void>
}

/** `ctx.agents` 中我们用到的部分。 */
export interface AgentRegistryLike {
  create(options: {
    sessionId: SessionId
    agentOptions?: { provider?: string; model?: string }
    meta?: { cwd?: string; agentPreset?: string }
    setup?: AgentSetupLike
    signal?: AbortSignal
  }): Promise<AgentHandleLike>
  resume(options: {
    resumeSessionId: SessionId
    agentOptions?: { provider?: string; model?: string }
    setup?: AgentSetupLike
  }): Promise<AgentHandleLike>
  get(sessionId: SessionId): { readonly id: SessionId } | undefined
}

/**
 * 创建/恢复会话时组合其「作用域世界」（preset、工具等）的回调。
 *
 * web app 把面向模型的工具行都藏在 agent preset 后面：不挂 preset 的会话几乎没有工具，
 * 模型会退化成只会说话。这是最容易漏、又最像「它不肯干活」的故障。
 */
export type AgentSetupLike = (agentCtx: unknown, agent: unknown) => void | Promise<void>

export interface PeerSessionsOptions {
  registry: AgentRegistryLike
  /** 新建会话记录的工作目录（绝对路径，创建后不可改）。 */
  cwd: string
  /** 本通道创建/恢复的会话统一使用的模型。 */
  sessionOptions?: { provider?: string; model?: string }
  /** 探测持久化会话是否已存在；缺省视为不存在。 */
  sessionExists?: (sessionId: SessionId) => Promise<boolean>
  /** 组合会话作用域世界（挂 preset、人设等），同时提供对应的微信联系人。 */
  setup?: (agentCtx: unknown, agent: unknown, peerId: string) => void | Promise<void>
  /** 新建会话时写进 header 的 preset id，供以后 resume 复原同一套工具。 */
  agentPreset?: string
  /** 诊断出口。 */
  onError?: (error: unknown, peerId: string) => void
  /**
   * 会话拿到手之后（新建或恢复）调一次，用于设置权限预设。
   *
   * 放在这里而不是 create 的参数里：预设要记录在 session 对象上，
   * 而 session 只有句柄返回之后才拿得到。
   */
  onHandle?: (handle: AgentHandleLike, peerId: string) => void
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
  async acquire(peerId: string, generation = 0): Promise<AgentHandleLike> {
    const key = `${peerId}#${String(generation)}`
    const existing = this.live.get(key)
    if (existing !== undefined) return existing

    const sessionId = sessionIdFor(peerId, generation)
    const registry = this.options.registry

    // 用 `get` 而不是只信本地表：会话可能被 GUI 或上一轮运行启动着。
    const running = registry.get(sessionId)
    if (running !== undefined) {
      const adopted: AgentHandleLike = {
        agent: running as AgentHandleLike['agent'],
        // 借用别人的 agent，绝不能在这里 dispose——那会把 GUI 的会话也一起关掉。
        dispose: async () => {},
      }
      this.live.set(key, adopted)
      this.options.onHandle?.(adopted, peerId)
      return adopted
    }

    const options = this.options.sessionOptions === undefined ? {} : { agentOptions: this.options.sessionOptions }
    let handle: AgentHandleLike
    const setup = this.options.setup === undefined ? {} : {
      setup: async (agentCtx: unknown, agent: unknown) => { await this.options.setup!(agentCtx, agent, peerId) },
    }
    if ((await this.options.sessionExists?.(sessionId)) === true) {
      handle = await registry.resume({ resumeSessionId: sessionId, ...options, ...setup })
    } else {
      try {
        handle = await registry.create({
          sessionId,
          meta: {
            cwd: this.options.cwd,
            ...(this.options.agentPreset === undefined ? {} : { agentPreset: this.options.agentPreset }),
          },
          ...options,
          ...setup,
        })
      } catch (error) {
        // 竞态：并发拿到同一个 peer 时 `create` 会因 id 已存在而抛。再 `get` 一次。
        const raced = registry.get(sessionId)
        if (raced === undefined) throw error
        handle = { agent: raced as AgentHandleLike['agent'], dispose: async () => {} }
      }
    }

    this.live.set(key, handle)
    this.options.onHandle?.(handle, peerId)
    return handle
  }

  /**
   * 投递一条消息。
   *
   * 句柄可能已经死了（agent 被 GUI 关掉、或被上一轮运行 dispose）。
   * `followup` 打到死 agent 上是「接受然后丢掉」，所以这里先问 registry 它还在不在，
   * 不在就丢掉句柄重建一次——这是唯一能在投递路径上发现静默丢消息的地方。
   */
  async deliver(peerId: string, message: never, generation = 0): Promise<void> {
    const key = `${peerId}#${String(generation)}`
    const cached = this.live.get(key)
    if (cached !== undefined && this.options.registry.get(cached.agent.id) === undefined) {
      this.live.delete(key)
    }
    const handle = await this.acquire(peerId, generation)
    handle.agent.followup(message)
  }

  /**
   * 打断某个 peer 正在跑的一轮。
   *
   * 返回 false 表示「没有可打断的」：没有句柄、agent 没暴露 cancel、
   * 或者它本来就不在跑。三种情况对用户都是同一句话，不必区分。
   */
  async cancel(peerId: string, generation = 0): Promise<boolean> {
    const handle = this.live.get(`${peerId}#${String(generation)}`)
    if (handle === undefined) return false
    const agent = handle.agent
    if (agent.cancel === undefined) return false
    if (agent.status !== undefined && agent.status !== 'running') return false
    try {
      agent.cancel({ kind: 'user' })
      return true
    } catch (error) {
      this.options.onError?.(error, peerId)
      return false
    }
  }

  /** 释放一个 peer 的句柄（不 dispose 借用的）。 */
  async release(peerId: string, generation = 0): Promise<void> {
    const key = `${peerId}#${String(generation)}`
    const handle = this.live.get(key)
    this.live.delete(key)
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

  /** 当前持有的 peer（含代次），供诊断与 GUI 展示。 */
  peers(): readonly string[] {
    return [...this.live.keys()]
  }
}
