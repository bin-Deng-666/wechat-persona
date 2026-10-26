/** Durable correspondence between original WeChat input, agent batches and actual delivery. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { WeixinMessage } from '../ilink/types.ts'
import { atomicJson, SerialWork } from '../storage/atomic.ts'

export type DeliveryStatus = 'pending' | 'sending' | 'accepted' | 'failed' | 'unknown' | 'cancelled'
export interface DeliveryUnit {
  id: string
  peerId: string
  generation: number
  activityId: string
  groupId: string
  kind: 'text' | 'sticker' | 'file'
  value: string
  contextToken?: string
  status: DeliveryStatus
  createdAt: number
  error?: string
}
export interface InboundRecord {
  id: string
  peerId: string
  generation: number
  receivedAt: number
  text: string
  raw: WeixinMessage
  status: 'received' | 'submitted' | 'control' | 'cancelled'
  batchId?: string
}
export interface AgentBatch {
  id: string
  activityId: string
  generation: number
  inputIds: string[]
  content: unknown[]
  status: 'pending' | 'submitted' | 'cancelled'
}
export interface TaskState {
  status?: 'active' | 'completed' | 'cancelled'
  generation: number
  goal: string
  constraints: string[]
  completed: string[]
  pending: string[]
  waitingFor: string
}
interface PeerHistory {
  task?: TaskState
  schemaVersion: 1
  peerId: string
  inputs: InboundRecord[]
  batches: AgentBatch[]
  deliveries: DeliveryUnit[]
  notices: { at: number; text: string }[]
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

export class ConversationStore {
  private readonly documents = new Map<string, PeerHistory>()
  private readonly queues = new Map<string, SerialWork>()
  readonly dir: string | undefined
  constructor(dir?: string) { this.dir = dir }
  private queue(peerId: string): SerialWork {
    let queue = this.queues.get(peerId)
    if (!queue) { queue = new SerialWork(); this.queues.set(peerId, queue) }
    return queue
  }
  private async read(peerId: string): Promise<PeerHistory> {
    const cached = this.documents.get(peerId)
    if (cached) return cached
    let state: PeerHistory = { schemaVersion: 1, peerId, inputs: [], batches: [], deliveries: [], notices: [] }
    if (this.dir) {
      try {
        state = JSON.parse(await readFile(join(this.dir, `${digest(peerId)}.json`), 'utf8'))
        if (state.schemaVersion !== 1 || state.peerId !== peerId || !Array.isArray(state.inputs) || !Array.isArray(state.batches) || !Array.isArray(state.deliveries) || !Array.isArray(state.notices)) throw new Error('Invalid conversation history')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    this.documents.set(peerId, state)
    return state
  }
  private change<T>(peerId: string, fn: (state: PeerHistory) => T): Promise<T> {
    return this.queue(peerId).run(async () => {
      const state = structuredClone(await this.read(peerId))
      const value = fn(state)
      if (this.dir) await atomicJson(join(this.dir, `${digest(peerId)}.json`), state)
      this.documents.set(peerId, state)
      return value
    })
  }
  async peers(): Promise<string[]> {
    if (this.dir) {
      let names: string[] = []
      try { names = await readdir(this.dir) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/u.test(name))) {
        const state = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as PeerHistory
        await this.read(state.peerId)
      }
    }
    return [...this.documents.keys()]
  }
  /** Store before advancing the polling cursor. IDs are scoped to a contact. */
  async receive(peerId: string, generation: number, raw: WeixinMessage, text: string, now: number): Promise<{ record: InboundRecord; fresh: boolean }> {
    const id = raw.message_id === undefined ? randomUUID() : `wx_${digest(`${peerId}\0${String(raw.message_id)}`)}`
    return await this.change(peerId, state => {
      const old = state.inputs.find(input => input.id === id)
      if (old) return { record: old, fresh: false }
      const record: InboundRecord = { id, peerId, generation, raw, text, receivedAt: now, status: 'received' }
      state.inputs.push(record)
      return { record, fresh: true }
    })
  }
  async inputStatus(peerId: string, ids: readonly string[], status: InboundRecord['status'], batchId?: string): Promise<void> {
    await this.change(peerId, state => { for (const input of state.inputs) if (ids.includes(input.id)) { input.status = status; if (batchId) input.batchId = batchId } })
  }
  async saveBatch(peerId: string, batch: AgentBatch): Promise<void> {
    await this.change(peerId, state => { const index = state.batches.findIndex(item => item.id === batch.id); if (index < 0) state.batches.push(batch); else state.batches[index] = batch })
  }
  async saveDelivery(unit: DeliveryUnit): Promise<void> {
    await this.change(unit.peerId, state => { const index = state.deliveries.findIndex(item => item.id === unit.id); if (index < 0) state.deliveries.push(structuredClone(unit)); else state.deliveries[index] = structuredClone(unit) })
  }
  async saveTask(peerId: string, task: TaskState, signal: AbortSignal): Promise<void> {
    await this.change(peerId, state => { signal.throwIfAborted(); state.task = { ...task, status: task.status ?? (task.pending.length || task.waitingFor ? 'active' : 'completed') } })
  }
  async cancelTask(peerId: string, generation: number): Promise<void> {
    await this.change(peerId, state => { if (state.task?.generation === generation) state.task = { ...state.task, status: 'cancelled', pending: [], waitingFor: '' } })
  }
  async notice(peerId: string, text: string): Promise<void> {
    await this.change(peerId, state => { state.notices.push({ at: Date.now(), text }); state.notices = state.notices.slice(-30) })
  }
  async history(peerId: string): Promise<Readonly<PeerHistory>> { await this.queue(peerId).idle(); return structuredClone(await this.read(peerId)) }
  /** Model-facing facts; never claim a delivery was read by the recipient. */
  async context(peerId: string, generation: number): Promise<string> {
    const state = await this.history(peerId)
    const inputs = state.inputs.filter(input => input.generation === generation && input.status === 'submitted').slice(-8)
    const deliveries = state.deliveries.filter(item => item.generation === generation).slice(-12)
    return JSON.stringify({
      task: state.task?.generation === generation ? state.task : undefined,
      sources: inputs.map(input => ({ entryId: input.id, saidAt: new Date(input.receivedAt).toISOString(), text: input.text, quoteOf: input.raw.quote?.message_id,
        quotedText: input.raw.quote?.message_id === undefined ? undefined : state.inputs.find(candidate => String(candidate.raw.message_id) === String(input.raw.quote!.message_id))?.text })),
      deliveries: deliveries.map(item => ({ kind: item.kind, content: item.value.slice(0, 400), status: item.status, error: item.error })),
      controls: state.notices.slice(-5),
    })
  }
}
