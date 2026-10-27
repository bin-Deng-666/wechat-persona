/** 按联系人持久化个人记忆，使用文件事务保护并发写入与版本检查。 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicJson, SerialWork } from '../storage/atomic.ts'
import { withFileLock } from '../storage/lock.ts'
import { emptyState, isDuplicate, memoryFields, normalize, proposalKeys, validateProposal, validateState, type Memory, type Proposal, type State } from './model.ts'
import { habitContext, searchMemories } from './search.ts'

interface ContactMemory extends State { peerId: string; legacy: string[] }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export class PeerMemory {
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
        const state = JSON.parse(await readFile(join(this.dir,name),'utf8')) as ContactMemory
        this.validate(state)
        if (hash(state.peerId) + '.json' !== name) throw new Error('记忆文件与联系人不匹配，原文件已保留')
      }
      let legacy: Record<string,unknown> = {}
      try { legacy = JSON.parse(await readFile(join(dirname(this.dir),'memories.json'),'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      for (const [peerId,value] of Object.entries(legacy)) {
        if (!Array.isArray(value)) continue
        await withFileLock(this.file(peerId),async () => {
          try { await readFile(this.file(peerId)); return }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          await atomicJson(this.file(peerId),{...emptyState(),peerId,legacy:value.filter(item => typeof item === 'string')})
        })
      }
      this.loaded = true
    })
  }
  private file(peerId: string): string { return join(this.dir,`${hash(peerId)}.json`) }
  private validate(state: ContactMemory): void {
    validateState(state)
    if (typeof state.peerId !== 'string' || !Array.isArray(state.legacy)) throw new Error('记忆文件格式错误，原文件已保留')
  }
  private current(peerId: string): ContactMemory {
    try {
      const state = JSON.parse(readFileSync(this.file(peerId),'utf8')) as ContactMemory
      this.validate(state)
      if (state.peerId !== peerId) throw new Error('记忆文件的联系人不匹配')
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return {...emptyState(),peerId,legacy:[]}
    }
  }
  // 同步读取小型原子快照，保留 agent 工具的同步检索接口，同时立即看见另一个进程的修改。
  get(peerId: string): readonly Memory[] { return this.current(peerId).memories }
  legacy(peerId: string): readonly string[] { return this.current(peerId).legacy }
  search(peerId: string,query: string,limit = 12): Memory[] { return searchMemories([...this.get(peerId)],query,limit) }
  habits(peerId: string,budget = 2200): string { return habitContext([...this.get(peerId)],budget) }
  async apply(peerId: string,proposal: Proposal,signal?: AbortSignal): Promise<Memory | undefined> {
    validateProposal(proposal)
    return await withFileLock(this.file(peerId),async () => {
      const state = this.current(peerId), now = new Date().toISOString()
      let saved: Memory | undefined
      if (proposal.action === 'add') {
        if (isDuplicate(state,proposal)) throw new Error('记忆已存在或已被删除，不重复收录')
        saved = {id:randomUUID(),version:1,...memoryFields(proposal),createdAt:now,updatedAt:now,sources:proposal.sources}
        state.memories.push(saved)
      } else {
        const index = state.memories.findIndex(memory => memory.id === proposal.targetId), old = state.memories[index]
        if (!old || old.version !== proposal.targetVersion) throw new Error('记忆已变化，请重新检索最新 ID 和版本')
        if (proposal.action === 'delete') {
          state.suppressed = [...new Set([...state.suppressed,...proposalKeys(old)])]; state.memories.splice(index,1)
        } else {
          if (state.memories.some(memory => memory.id !== old.id && normalize(memory.content) === normalize(proposal.content))) throw new Error('更新内容与其他记忆重复')
          state.suppressed = [...new Set([...state.suppressed,...proposalKeys({content:old.content,sources:[]})])]
          saved = {...old,...memoryFields(proposal),version:old.version + 1,updatedAt:now,sources:[...old.sources,...proposal.sources]}
          state.memories[index] = saved
        }
      }
      this.validate(state); await atomicJson(this.file(peerId),state,signal)
      return saved
    },signal)
  }
  async clear(peerId: string): Promise<void> {
    await withFileLock(this.file(peerId),async () => {
      const state = this.current(peerId)
      state.suppressed = [...new Set([...state.suppressed,...state.memories.flatMap(proposalKeys)])]
      state.memories = []; state.legacy = []
      await atomicJson(this.file(peerId),state)
    })
  }
}
