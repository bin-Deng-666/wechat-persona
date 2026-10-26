/** Memory belongs to a contact, with exact human evidence and optimistic version checks. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicJson, SerialWork } from '../storage/atomic.ts'
import { emptyState, isDuplicate, memoryFields, normalize, proposalKeys, validateProposal, validateState, type Memory, type Proposal, type State } from './model.ts'
import { habitContext, searchMemories } from './search.ts'

interface ContactMemory extends State { peerId: string; legacy: string[] }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export class PeerMemory {
  private readonly states = new Map<string, ContactMemory>()
  private readonly work = new SerialWork()
  private loaded = false
  readonly dir: string
  constructor(dir: string) { this.dir = dir }
  async load(): Promise<void> {
    await this.work.run(async () => {
      if (this.loaded) return
      let names: string[] = []
      try { names = await readdir(this.dir) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/u.test(name))) {
        const state = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as ContactMemory
        validateState(state)
        if (typeof state.peerId !== 'string' || !Array.isArray(state.legacy) || hash(state.peerId) + '.json' !== name) throw new Error('Invalid contact memory; original file preserved')
        this.states.set(state.peerId, state)
      }
      // Legacy assistant-authored strings have no human evidence. Keep them visible for review,
      // but never promote them to trusted personal facts or fabricate a source.
      let legacy: Record<string, unknown> = {}
      try { legacy = JSON.parse(await readFile(join(dirname(this.dir), 'memories.json'), 'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      for (const [peerId, value] of Object.entries(legacy)) {
        if (this.states.has(peerId) || !Array.isArray(value)) continue
        const state: ContactMemory = { ...emptyState(), peerId, legacy: value.filter((item): item is string => typeof item === 'string') }
        await atomicJson(this.file(peerId), state)
        this.states.set(peerId, state)
      }
      this.loaded = true
    })
  }
  private file(peerId: string): string { return join(this.dir, `${hash(peerId)}.json`) }
  get(peerId: string): readonly Memory[] { return structuredClone(this.states.get(peerId)?.memories ?? []) }
  legacy(peerId: string): readonly string[] { return [...(this.states.get(peerId)?.legacy ?? [])] }
  search(peerId: string, query: string, limit = 12): Memory[] { return searchMemories([...this.get(peerId)], query, limit) }
  habits(peerId: string, budget = 2200): string { return habitContext([...this.get(peerId)], budget) }
  async apply(peerId: string, proposal: Proposal, signal?: AbortSignal): Promise<Memory | undefined> {
    validateProposal(proposal)
    return await this.work.run(async () => {
      signal?.throwIfAborted()
      const state: ContactMemory = structuredClone(this.states.get(peerId) ?? { ...emptyState(), peerId, legacy: [] })
      const now = new Date().toISOString()
      let saved: Memory | undefined
      if (proposal.action === 'add') {
        if (isDuplicate(state, proposal)) throw new Error('记忆已存在或已被删除，不重复收录')
        saved = { id: randomUUID(), version: 1, ...memoryFields(proposal), createdAt: now, updatedAt: now, sources: proposal.sources }
        state.memories.push(saved)
      } else {
        const index = state.memories.findIndex(memory => memory.id === proposal.targetId)
        const old = state.memories[index]
        if (!old || old.version !== proposal.targetVersion) throw new Error('记忆已变化，请重新检索最新 ID 和版本')
        if (proposal.action === 'delete') {
          state.suppressed = [...new Set([...state.suppressed, ...proposalKeys(old)])]
          state.memories.splice(index, 1)
        } else {
          if (state.memories.some(memory => memory.id !== old.id && normalize(memory.content) === normalize(proposal.content))) throw new Error('更新内容与其他记忆重复')
          state.suppressed = [...new Set([...state.suppressed, ...proposalKeys({ content: old.content, sources: [] })])]
          saved = { ...old, ...memoryFields(proposal), version: old.version + 1, updatedAt: now, sources: [...old.sources, ...proposal.sources] }
          state.memories[index] = saved
        }
      }
      signal?.throwIfAborted()
      validateState(state)
      await atomicJson(this.file(peerId), state, signal)
      this.states.set(peerId, state)
      return saved
    })
  }
  async clear(peerId: string): Promise<void> {
    await this.work.run(async () => {
      const state = structuredClone(this.states.get(peerId) ?? { ...emptyState(), peerId, legacy: [] })
      state.suppressed = [...new Set([...state.suppressed, ...state.memories.flatMap(proposalKeys)])]
      state.memories = []; state.legacy = []
      await atomicJson(this.file(peerId), state)
      this.states.set(peerId, state)
    })
  }
}
