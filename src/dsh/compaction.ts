/**
 * 上下文压缩：把一个会话的旧历史替换成一条摘要。
 *
 * 只声明用得到的部分，不导入 `@deepseek-ai/dsh-compaction`：精简宿主可能没有
 * 这个服务，缺了要能降级成一句提示，而不是让插件加载失败。
 *
 * @module wechat-persona/dsh/compaction
 */

import type { AgentHandleLike } from './sessions.ts'

/** 手动压缩的结果；只取用得到的计数。 */
export interface CompactionResultLike {
  readonly shadowedSeqs: readonly unknown[]
  readonly shadowedTokenCount: number
  readonly summarySeq: unknown
}

/**
 * `compactNow` 需要的 agent 形状。
 *
 * `runMaintenance` 是必需的那一件：引擎靠它把手工压缩和正在跑的一轮串行化，
 * 会话不空闲时它会直接抛 `busy`，而不是排队等待。
 */
export interface CompactableAgent {
  readonly session?: unknown
  readonly options?: { readonly provider?: string; readonly model?: string }
  runMaintenance?<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

/** `ctx.compaction` 里我们用到的部分。 */
export interface CompactionEngineLike {
  compactNow(
    agent: CompactableAgent,
    signal: AbortSignal,
    sourceCommandId?: string,
  ): Promise<CompactionResultLike | null>
}

/** 一次压缩请求的结论；对应的微信文案在 `wechat/commands.ts`。 */
export type CompactOutcome =
  | { kind: 'done'; shadowed: number; tokens: number }
  | { kind: 'nothing' }
  | { kind: 'busy' }
  | { kind: 'cancelled' }
  | { kind: 'unavailable' }
  | { kind: 'failed'; message: string }

/** 宿主对「可预期失败」使用的错误名；码比字符串更稳。 */
const MANUAL_ERROR_NAME = 'ManualCompactionError'

/**
 * 压缩一个联系人的当前对话。
 *
 * @param options - 压缩引擎、取会话的方式、目标 peer 与诊断出口。
 * @returns 可判定结论，绝不抛出：这是一条用户命令，必须有回复。
 */
export async function compactPeer(options: {
  engine: CompactionEngineLike | undefined
  agentAt: (peerId: string, generation?: number) => Promise<AgentHandleLike>
  peerId: string
  generation: number
  report?: (line: string, detail?: unknown) => void
}): Promise<CompactOutcome> {
  if (options.engine === undefined) return { kind: 'unavailable' }

  let agent: CompactableAgent
  try {
    agent = (await options.agentAt(options.peerId, options.generation)).agent
  } catch (error) {
    options.report?.('取会话失败，无法压缩', { peerId: options.peerId, error: String(error) })
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
  // 老宿主可能没有 runMaintenance；缺了就没有安全的串行化方式，宁可不做。
  if (typeof agent.runMaintenance !== 'function') return { kind: 'unavailable' }

  try {
    const result = await options.engine.compactNow(agent, new AbortController().signal)
    if (result === null) return { kind: 'nothing' }
    return { kind: 'done', shadowed: result.shadowedSeqs.length, tokens: result.shadowedTokenCount }
  } catch (error) {
    const code = error instanceof Error && error.name === MANUAL_ERROR_NAME
      ? (error as { code?: unknown }).code
      : undefined
    if (code === 'busy') return { kind: 'busy' }
    if (code === 'cancelled') return { kind: 'cancelled' }
    options.report?.('压缩失败', { peerId: options.peerId, code: code ?? 'unknown', error: String(error) })
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}
