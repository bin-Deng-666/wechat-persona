/** Contact-scoped adaptation of agent-personal-memory's evidence and write policy. MIT; see LICENSE. */
import type { ConversationStore } from '../chat/history.ts'
import { createProposal, digest, isLongTermChange, type Memory, type MemoryType } from './model.ts'
import { validatePersonalEvidence } from './evidence.ts'
import type { PeerMemory } from './store.ts'

export interface MemoryActivity { id: string; generation: number; inputIds: readonly string[]; signal: AbortSignal }
export interface MemoryWrite {
  action: 'add' | 'update' | 'delete'
  entryId: string
  quote: string
  reason: string
  title?: string
  content?: string
  type?: MemoryType
  scope?: string
  certainty?: Memory['certainty']
  tags?: string[]
  targetId?: string
  targetVersion?: number
  explicitRequestQuote?: string
}
export class MemoryCapture {
  private activityId = ''
  private readonly queried = new Set<string>()
  private searched = false
  private writes = 0
  private readonly memory: PeerMemory
  private readonly history: ConversationStore
  readonly peerId: string
  private readonly activity: () => MemoryActivity | undefined
  constructor(memory: PeerMemory, history: ConversationStore, peerId: string, activity: () => MemoryActivity | undefined) {
    this.memory = memory; this.history = history; this.peerId = peerId; this.activity = activity
  }
  private current(): MemoryActivity {
    const current = this.activity()
    if (!current || current.signal.aborted) throw new Error('当前没有可写入记忆的用户请求')
    if (current.id !== this.activityId) { this.activityId = current.id; this.queried.clear(); this.searched = false; this.writes = 0 }
    return current
  }
  search(query: string, id?: string): readonly Memory[] {
    this.current()
    this.searched = true
    const found = id ? this.memory.get(this.peerId).filter(memory => memory.id === id) : this.memory.search(this.peerId, query)
    for (const memory of found) this.queried.add(`${memory.id}:${memory.version}`)
    return found
  }
  async write(input: MemoryWrite, signal: AbortSignal): Promise<{ action: string; id?: string; version?: number; silent: boolean }> {
    const activity = this.current()
    signal.throwIfAborted(); activity.signal.throwIfAborted()
    if (!this.searched) throw new Error('先使用 wechat_memory_search 检索和去重')
    if (this.writes >= 3) throw new Error('当前请求最多写入三条个人记忆')
    const history = await this.history.history(this.peerId)
    const source = history.inputs.find(message => message.id === input.entryId)
    if (!source || !activity.inputIds.includes(source.id) || !input.quote.trim() || !source.text.includes(input.quote)) throw new Error('记忆证据必须逐字引用当前活动的原始用户消息与真实 entryId')
    const explicit = Boolean(input.explicitRequestQuote && source.text.includes(input.explicitRequestQuote))
    if (input.action !== 'add' && !this.queried.has(`${input.targetId}:${input.targetVersion}`)) throw new Error('更新和删除必须先检索目标的最新 ID 和版本')
    if (input.action === 'delete' && (!explicit || !/(忘记|忘掉|删除|移除|不要保留|\b(forget|delete|remove)\b)/iu.test(input.explicitRequestQuote!))) throw new Error('删除需要当前用户明确的忘记请求')
    if (input.action === 'update' && !isLongTermChange(source.text)) throw new Error('更新需要用户明确纠正事实或说明长期变化')
    if (input.action === 'add' && (!input.title?.trim() || !input.content?.trim() || !input.type)) throw new Error('新增记忆必须提供标题、内容和分类')
    const old = this.memory.get(this.peerId).find(memory => memory.id === input.targetId)
    const proposal = createProposal({
      ...(old ?? {}), ...input, origin: explicit ? 'explicit' : 'automatic',
      sources: [{ sessionId: `wechat:${this.peerId}:${activity.generation}`, entryId: source.id, fingerprint: digest(source.text), quote: input.quote, timestamp: new Date(source.receivedAt).toISOString() }],
    })
    validatePersonalEvidence(proposal)
    const saved = await this.memory.apply(this.peerId, proposal, AbortSignal.any([signal, activity.signal]))
    this.writes++
    return { action: input.action, id: saved?.id ?? input.targetId, version: saved?.version, silent: true }
  }
}
