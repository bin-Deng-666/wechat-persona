/** 不依赖 DSH 的设置数据层。常驻网页与 bot 共用文件事务与相同的领域校验。 */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { PersonaStore } from '../../../../src/persona/store.ts'
import { parsePersonaCard } from '../../../../src/persona/card.ts'
import { ChatSettingsStore } from '../../../../src/chat/settings.ts'
import { PeerMemory } from '../../../../src/memory/store.ts'
import { StickerLibrary } from '../../../../src/stickers/library.ts'
import { createProposal, memoryFields, type Memory, type MemoryType } from '../../../../src/memory/model.ts'
import { atomicJson } from '../../../../src/storage/atomic.ts'
import type { ChatPatch, ChatSummary, PanelHandlers, MemoryInput } from './routes.ts'

type LiveActions = Pick<PanelHandlers,'status' | 'begin' | 'poll' | 'verifyCode' | 'logout' | 'control'>

export class SettingsRepository {
  readonly personas: PersonaStore
  readonly settings: ChatSettingsStore
  readonly memory: PeerMemory
  readonly stickers: StickerLibrary
  readonly dataDir: string
  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.personas = new PersonaStore(join(dataDir,'personas'))
    this.settings = new ChatSettingsStore(join(dataDir,'chats'))
    this.memory = new PeerMemory(join(dataDir,'memory'))
    this.stickers = new StickerLibrary(join(dataDir,'stickers'))
  }
  async listPersonas() {
    return [...(await this.personas.snapshot()).personas.values()].map(persona => ({id:persona.card.id,name:persona.card.name,description:persona.card.description,warnings:persona.warnings.map(w => `${w.path}: ${w.message}`)}))
  }
  async readPersona(id: string) {
    try { return {ok:true,raw:await readFile(join(this.dataDir,'personas',id,'persona.json'),'utf8')} }
    catch { return {ok:false,error:'这个 id 还没有人格卡'} }
  }
  async writePersona(id: string,raw: string) {
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return {ok:false,issues:['人格卡不是有效的 JSON'],warnings:[]} }
    const result = parsePersonaCard(parsed,id)
    if (!result.ok) return {ok:false,issues:result.issues.map(issue => `${issue.path}: ${issue.message}`),warnings:[]}
    await atomicJson(join(this.dataDir,'personas',id,'persona.json'),parsed)
    return {ok:true,issues:[],warnings:result.warnings.map(w => `${w.path}: ${w.message}`)}
  }
  async chats(extra: readonly string[] = []): Promise<ChatSummary[]> {
    const peers = new Set([...await this.settings.listPeers(),...extra])
    try {
      const activity = JSON.parse(await readFile(join(this.dataDir,'last-seen.json'),'utf8')) as Record<string,unknown>
      for (const peer of Object.keys(activity)) peers.add(peer)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return await Promise.all([...peers].sort().map(async peerId => ({peerId,...await this.settings.get(peerId)})))
  }
  async setChat(patch: ChatPatch): Promise<ChatSummary> {
    const saved = await this.settings.update(patch.peerId,current => ({...current,
      ...(patch.personaId === undefined ? {} : {personaId:patch.personaId || undefined}),
      ...(patch.enabled === undefined ? {} : {enabled:patch.enabled}),
      ...(patch.maxChars === undefined ? {} : {maxChars:patch.maxChars ?? undefined}),
      ...(patch.split === undefined ? {} : {split:patch.split ?? undefined}),
    }))
    return {peerId:patch.peerId,...saved}
  }
  private async saveMemory(input: MemoryInput) {
    await this.memory.load()
    const existing = input.id ? this.memory.get(input.peerId).find(memory => memory.id === input.id) : undefined
    if (input.id && !existing) return {ok:false,issues:['这条记忆已经不存在，请刷新。']}
    try {
      await this.memory.apply(input.peerId,createProposal({
        ...(existing ? memoryFields(existing) : {}),action:existing ? 'update' : 'add',
        ...(existing ? {targetId:existing.id,targetVersion:input.version} : {}),
        title:input.title,content:input.content,type:input.type as MemoryType,scope:input.scope,
        certainty:input.certainty as Memory['certainty'],tags:input.tags,origin:'manual',
      }))
      return {ok:true,issues:[]}
    } catch (error) { return {ok:false,issues:[error instanceof Error ? error.message : String(error)]} }
  }
  handlers(live: LiveActions,extraPeers: () => readonly string[] = () => []): PanelHandlers {
    return {
      ...live,
      personas:async () => await this.listPersonas(),readPersona:async id => await this.readPersona(id),writePersona:async (id,raw) => await this.writePersona(id,raw),
      chats:async () => await this.chats(extraPeers()),setChat:async patch => await this.setChat(patch),
      memory:async peerId => { await this.memory.load(); return {memories:[...this.memory.get(peerId)],legacy:[...this.memory.legacy(peerId)]} },
      saveMemory:async input => await this.saveMemory(input),
      deleteMemory:async input => {
        await this.memory.load()
        const existing = this.memory.get(input.peerId).find(memory => memory.id === input.id)
        if (!existing) return {ok:false,issues:['这条记忆已经不存在，请刷新。']}
        try {
          await this.memory.apply(input.peerId,createProposal({...memoryFields(existing),action:'delete',targetId:existing.id,targetVersion:input.version,origin:'manual'}))
          return {ok:true,issues:[]}
        } catch (error) { return {ok:false,issues:[error instanceof Error ? error.message : String(error)]} }
      },
      clearMemory:async peer => { await this.memory.load(); await this.memory.clear(peer); return {ok:true} },
      stickers:async peer => ({images:await this.stickers.catalog(peer),shared:(await this.stickers.sharedEntries()).map(item => ({name:item.name}))}),
      stickerImage:async input => {
        const found = await this.stickers.locate(input.peerId,input.id)
        if (!found) return undefined
        return {data:await readFile(found.file),mediaType:found.sticker.mediaType}
      },
      saveSticker:async input => {
        try {
          const saved = await this.stickers.revise(input.peerId,input.id,input)
          return {ok:!!saved,issues:saved ? [] : ['没有这张素材']}
        } catch (error) { return {ok:false,issues:[error instanceof Error ? error.message : String(error)]} }
      },
      forgetSticker:async input => ({ok:await this.stickers.forget(input.peerId,input.id)}),
      publishSticker:async input => {
        try {
          const file = await this.stickers.publish(input.peerId,input.id,input.name)
          return {ok:!!file,issues:file ? [] : ['名字不合法，或素材不存在']}
        } catch (error) { return {ok:false,issues:[error instanceof Error ? error.message : String(error)]} }
      },
      unpublishSticker:async name => ({ok:await this.stickers.unpublish(name)}),
    }
  }
}
