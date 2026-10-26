/**
 * 把「这一步要不要执行」的审批发到微信，等一句回复。
 *
 * DSH 的审批是一个 waterfall（`approval/request`）：插件要么当场给结论，要么交回给 GUI。
 * 微信里没有按钮，所以这里把请求变成一句话，等用户回 `1`/`2`，再把结果还给主循环。
 *
 * 三条纪律：
 * - **同一时刻一个 peer 只有一个待决审批**：后到的会把前一个判成取消，避免答错对象。
 * - **必须有超时**：微信那头可能一直不回，超时就当取消（fail closed，不能默认放行）。
 * - **只认明确的答复**：含糊的话不能被当成「允许」。
 *
 * @module wechat-persona/bridge/approval
 */

/** 审批结论。 */
export type ApprovalAnswer = 'allow' | 'deny' | 'cancel'

export interface ApprovalAsk {
  peerId: string
  /** 要执行的工具名。 */
  toolName: string
  /** 为什么需要确认（模型/工具给的理由）。 */
  reason?: string
}

export interface ApprovalBridgeOptions {
  /** 把提示发到微信。 */
  ask: (peerId: string, text: string) => Promise<void> | void
  /** 等多久算超时，毫秒；默认 10 分钟。 */
  timeoutMs?: number
  /** 诊断出口。 */
  report?: (line: string, detail?: unknown) => void
}

interface Pending {
  settle: (answer: ApprovalAnswer) => void
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000

/** 允许。 */
const ALLOW = new Set(['1', 'y', 'yes', '是', '允许', '同意', '可以', 'ok'])
/** 拒绝。 */
const DENY = new Set(['2', 'n', 'no', '否', '拒绝', '不同意', '不行'])
/** 取消这一轮。 */
const CANCEL = new Set(['3', 'c', 'cancel', '取消', '算了', '停'])

/**
 * 把一句回复解析成审批结论。
 * @param text - 用户发来的原文。
 * @returns 明确的答复；含糊时 undefined（继续等）。
 */
export function parseApprovalAnswer(text: string): ApprovalAnswer | undefined {
  const normalized = text.trim().toLowerCase()
  if (normalized === '') return undefined
  if (ALLOW.has(normalized)) return 'allow'
  if (DENY.has(normalized)) return 'deny'
  if (CANCEL.has(normalized)) return 'cancel'
  return undefined
}

/**
 * 审批提示的文案。
 * @param ask - 请求内容。
 */
export function formatApprovalAsk(ask: ApprovalAsk): string {
  const lines = ['【需要你确认】', `要执行：${ask.toolName}`]
  const reason = ask.reason?.trim() ?? ''
  if (reason !== '') lines.push(`原因：${reason.length > 300 ? `${reason.slice(0, 300)}…` : reason}`)
  lines.push('', '回复 1 允许（只这一次）、2 拒绝、3 取消这一轮。')
  lines.push('十分钟没回复就当拒绝；回「/stop」可以直接停掉这一轮。')
  return lines.join('\n')
}

/** 审批的无状态部分与等待表。 */
export class ApprovalBridge {
  private readonly options: ApprovalBridgeOptions
  private readonly pending = new Map<string, Pending>()

  constructor(options: ApprovalBridgeOptions) {
    this.options = options
  }

  /** 这个 peer 有没有在等答复（入站消息据此判断是不是审批回复）。 */
  hasPending(peerId: string): boolean {
    return this.pending.has(peerId)
  }

  /**
   * 发起一次审批并等待答复。
   *
   * @param ask - 请求内容。
   * @returns 答复；超时或被打断时为 `cancel`。
   */
  async request(ask: ApprovalAsk): Promise<ApprovalAnswer> {
    // 同一 peer 上一条还没答完就又来一条：先把旧的判成取消，免得用户答的是上一条。
    this.finish(ask.peerId, 'cancel', '被新的审批请求顶掉')
    return await new Promise<ApprovalAnswer>(resolve => {
      const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      // 不 unref：这个定时器就是「等待」本身，被回收掉的话 Promise 永远不会 settle。
      const timer = setTimeout(() => {
        this.finish(ask.peerId, 'cancel', '等待超时')
      }, timeoutMs)
      this.pending.set(ask.peerId, {
        settle: answer => {
          clearTimeout(timer)
          this.pending.delete(ask.peerId)
          resolve(answer)
        },
      })
      try {
        void Promise.resolve(this.options.ask(ask.peerId, formatApprovalAsk(ask))).catch((error: unknown) => {
          this.options.report?.('审批提示没发出去', { error: String(error) })
          // 提示都发不出去，就别让主循环无限等：明确判成取消。
          this.finish(ask.peerId, 'cancel', '提示发送失败')
        })
      } catch (error) {
        this.options.report?.('审批提示没发出去', { error: String(error) })
        this.finish(ask.peerId, 'cancel', '提示发送失败')
      }
    })
  }

  /**
   * 尝试把一条入站消息当作审批答复。
   *
   * @param peerId - 发消息的人。
   * @param text - 消息原文。
   * @returns 被消费掉就 true（这条不该再进模型）；不是答复或没有待决审批时 false。
   */
  answer(peerId: string, text: string): boolean {
    if (!this.pending.has(peerId)) return false
    const answer = parseApprovalAnswer(text)
    if (answer === undefined) return false
    this.finish(peerId, answer, '用户答复')
    return true
  }

  /** 取消某个 peer 的待决审批（一轮结束时用）。 */
  cancel(peerId: string, why = '这一轮已经结束'): void {
    this.finish(peerId, 'cancel', why)
  }

  /** 取消全部（卸载时）。 */
  cancelAll(): void {
    for (const peerId of [...this.pending.keys()]) this.finish(peerId, 'cancel', '插件卸载')
  }

  private finish(peerId: string, answer: ApprovalAnswer, why: string): void {
    const entry = this.pending.get(peerId)
    if (entry === undefined) return
    this.pending.delete(peerId)
    this.options.report?.('审批结论', { peerId, answer, why })
    entry.settle(answer)
  }
}
