/**
 * 一个联系人的会话状态机：一次活动（activity）承载一到多轮回合。
 *
 * 这个文件负责「谁在跑、跑到哪一步」，不负责发消息。之所以要把它做成显式状态机，
 * 是因为「卡住不回复」几乎总是同一个形状：某个字段靠外部事件才会清掉，事件没来，
 * 状态就永久停在 running，之后所有输出都被当成「过期」丢掉，而外面看不出来。
 *
 * 关键约束：
 * - 回合边界（turn/end）必须自己把待认领集合清空，不能指望宿主再补一个 user/message。
 * - 任何等待都有可观察的时间戳，进度提示据此给出「过去了多久」，而不是重复同一句台词。
 *
 * @module wechat-persona/chat/conversation
 */

import { randomUUID } from 'node:crypto'
import type { InboundRecord } from './history.ts'
import type { MemoryActivity } from '../memory/capture.ts'
import { SerialWork } from '../storage/atomic.ts'
import type { ReplyScope } from '../reply/queue.ts'

/**
 * 回合阶段。
 *
 * - `preparing`：收到了消息，正在整理内容（下载媒体、拼批次）。
 * - `submitted`：批次已交给宿主，等它开一轮。
 * - `running`：宿主已开轮（turn/start），模型在跑。
 * - `compacting`：上下文压缩占用这个活动。
 * - `idle`：没有在跑的东西。
 */
export type ActivityPhase = 'preparing' | 'submitted' | 'running' | 'compacting' | 'idle'

/** 每个阶段的时间戳，用于算分段耗时。 */
export interface ActivityTimes {
  /** 收到第一条消息。 */
  created: number
  /** 交给宿主。 */
  submitted?: number
  /** 宿主开了这一轮。 */
  started?: number
  /** 这一轮第一段正文。 */
  firstText?: number
  /** 这一轮结束。 */
  ended?: number
}

export interface ConversationActivity extends MemoryActivity {
  controller: AbortController
  output: AbortController
  pendingMessages: Set<string>
  contextToken?: string
  phase: ActivityPhase
  at: ActivityTimes
  turn?: number
  suppressedTurns: Set<number>
}

export class PeerConversation {
  private readonly work = new SerialWork()
  private readonly ingress = new SerialWork()
  accept<T>(work: () => Promise<T>): Promise<T> { return this.ingress.run(work) }
  readonly pending: InboundRecord[] = []
  timer: NodeJS.Timeout | undefined
  activity: ConversationActivity | undefined
  private readonly byTurn = new Map<number, ConversationActivity>()
  private controls = new AbortController()
  epoch = 0
  controlScope(): ReplyScope { return { generation: this.generation, activityId: `control:${this.epoch}`, signal: this.controls.signal } }
  readonly peerId: string
  public generation: number
  constructor(peerId: string, generation: number) { this.peerId = peerId; this.generation = generation }
  schedule<T>(work: () => Promise<T>): Promise<T> { return this.work.run(work) }
  async whenIdle(): Promise<void> { await this.work.idle() }

  /** 有没有正在进行的工作。取消/进度/合并策略都据此判断，不看单个 phase 字面量。 */
  busy(): boolean {
    const activity = this.activity
    return activity !== undefined && !activity.signal.aborted && activity.phase !== 'idle'
  }

  begin(inputs: readonly InboundRecord[], at = Date.now()): ConversationActivity {
    let activity = this.activity
    if (!activity || activity.signal.aborted || activity.phase === 'idle') {
      const controller = new AbortController()
      activity = { id: randomUUID(), generation: this.generation, inputIds: [], signal: controller.signal, controller,
        output: new AbortController(), pendingMessages: new Set(), phase: 'preparing', at: { created: at },
        suppressedTurns: new Set() }
      this.activity = activity
    } else {
      // 同一轮里追加内容：旧输出的作用域作废，但活动本身继续。
      activity.output.abort()
      activity.output = new AbortController()
      activity.phase = 'preparing'
    }
    activity.inputIds = [...activity.inputIds, ...inputs.map(input => input.id)]
    activity.contextToken = inputs.at(-1)?.raw.context_token ?? activity.contextToken
    return activity
  }

  /** 批次已交给宿主，等它开轮。 */
  markSubmitted(at = Date.now()): void {
    const activity = this.activity
    if (!activity || activity.signal.aborted) return
    activity.phase = 'submitted'
    activity.at.submitted ??= at
  }

  /**
   * 收到了这一轮的任何一步事件。
   *
   * `turn/start` 不一定是我们先看到的（断线重连、事件顺序、宿主的补发都可能让它晚到），
   * 但只要模型已经开始产出步骤，这一轮就是在跑。把「靠单一事件判活」换成「见到进展就算活」，
   * 才不会因为漏掉一个事件就一直当作还在排队。
   */
  markRunning(at = Date.now()): void {
    const activity = this.activity
    if (!activity || activity.signal.aborted || activity.phase === 'idle') return
    activity.phase = 'running'
    activity.at.started ??= at
  }

  /** 这一轮第一段要发出去的正文。 */
  markFirstText(at = Date.now()): void {
    const activity = this.activity
    if (!activity || activity.signal.aborted) return
    activity.at.firstText ??= at
  }

  scope(activity = this.activity): ReplyScope | undefined {
    if (!activity) return undefined
    return { generation: activity.generation, activityId: activity.id, signal: AbortSignal.any([activity.signal, activity.output.signal]) }
  }

  /** Invalidate before awaiting cancellation, I/O, generation changes or model completion. */
  invalidate(): boolean {
    this.epoch++
    this.controls.abort()
    this.controls = new AbortController()
    const activity = this.activity
    const active = activity !== undefined && !activity.signal.aborted && activity.phase !== 'idle'
    activity?.controller.abort()
    activity?.output.abort()
    if (activity) { activity.phase = 'idle'; activity.at.ended ??= Date.now(); activity.pendingMessages.clear() }
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending.splice(0)
    return active
  }

  close(): void { this.invalidate(); this.controls.abort() }

  turnStart(turn: number, at = Date.now()): void {
    const activity = this.activity
    if (!activity || activity.signal.aborted) return
    // 新的一轮开始：之前排进来的输入已经被它接走，待认领集合到此清空。
    activity.pendingMessages.clear()
    activity.phase = 'running'
    activity.turn = turn
    activity.at.started ??= at
    this.byTurn.set(turn, activity)
  }

  messageClaimed(id: string): void { this.activity?.pendingMessages.delete(id) }

  /**
   * 事件该归到哪次活动。
   *
   * 判定只看「这个事件属于哪一轮」，不看当前有没有新输入在等——那是两种不同的事实。
   * 之前用「有输入未认领就丢弃输出」判断，会把这一轮已经生成的正文一起丢掉：
   * 用户在模型收工前又发一条，上一条的回答就永远发不出来。
   */
  eventActivity(turn?: number): ConversationActivity | undefined {
    const activity = this.activity
    if (!activity || activity.signal.aborted) return undefined
    if (turn === undefined) return activity
    // 还没见过 turn/start 时，先认这一轮：漏事件不该等于丢回答。
    if (activity.turn === undefined) return activity
    if (activity.turn === turn) return activity
    // 已经结束的轮次只保留到 turn/end 处理完为止。
    return this.byTurn.get(turn) === activity ? activity : undefined
  }

  /**
   * 一轮结束。
   *
   * 回合边界必须自己清空「待认领」集合：被折进这一轮的输入不会再有对应的 user/message 事件，
   * 留着不清会让之后每一段正文都被当成过期内容丢掉——那正是「一直不回复」的成因。
   */
  finish(turn?: number): ConversationActivity | undefined {
    const activity = this.eventActivity(turn)
    if (turn !== undefined) this.byTurn.delete(turn)
    if (!activity) return undefined
    activity.pendingMessages.clear()
    activity.phase = 'idle'
    activity.at.ended ??= Date.now()
    return activity
  }
}
