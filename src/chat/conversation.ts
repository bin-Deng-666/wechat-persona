/** One contact owns one activity, ordered preparation, and cancellable output revisions. */
import { randomUUID } from 'node:crypto'
import type { InboundRecord } from './history.ts'
import type { MemoryActivity } from '../memory/capture.ts'
import { SerialWork } from '../storage/atomic.ts'
import type { ReplyScope } from '../reply/queue.ts'
import type { ToolActivity } from '../dsh/events.ts'

export interface ConversationActivity extends MemoryActivity {
  controller: AbortController
  output: AbortController
  pendingMessages: Set<string>
  contextToken?: string
  phase: 'running' | 'compacting' | 'idle'
  turn?: number
  /** 当前这一步「在干什么」；用于长任务进度提示。 */
  status?: ToolActivity
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
  begin(inputs: readonly InboundRecord[]): ConversationActivity {
    let activity = this.activity
    if (!activity || activity.signal.aborted || activity.phase !== 'running') {
      const controller = new AbortController()
      activity = { id: randomUUID(), generation: this.generation, inputIds: [], signal: controller.signal, controller,
        output: new AbortController(), pendingMessages: new Set(), phase: 'running', suppressedTurns: new Set() }
      this.activity = activity
    } else {
      activity.output.abort()
      activity.output = new AbortController()
    }
    activity.inputIds = [...activity.inputIds, ...inputs.map(input => input.id)]
    activity.contextToken = inputs.at(-1)?.raw.context_token ?? activity.contextToken
    return activity
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
    if (activity) activity.phase = 'idle'
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending.splice(0)
    return active
  }
  close(): void { this.invalidate(); this.controls.abort() }
  turnStart(turn: number): void {
    if (!this.activity || this.activity.signal.aborted) return
    this.activity.turn = turn
    this.byTurn.set(turn, this.activity)
  }
  messageClaimed(id: string): void { this.activity?.pendingMessages.delete(id) }
  eventActivity(turn?: number): ConversationActivity | undefined {
    const activity = turn === undefined ? this.activity : this.byTurn.get(turn) ?? (this.activity?.turn === undefined ? this.activity : undefined)
    return activity && activity === this.activity && !activity.signal.aborted ? activity : undefined
  }
  finish(turn?: number): ConversationActivity | undefined {
    const activity = this.eventActivity(turn)
    if (turn !== undefined) this.byTurn.delete(turn)
    if (!activity) return undefined
    // Fresh steering may be queued while the old turn converges. Its next turn remains active.
    if (!activity.pendingMessages.size) activity.phase = 'idle'
    return activity
  }
}
