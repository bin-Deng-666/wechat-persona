/** 微信 → 原文/附件 → 会话系统提示词 → 素材识别 → 分条/表情队列的集成测试。 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { PNG } from 'pngjs'
import { Channel } from '../src/channel/runtime.ts'
import { PeerSystemPrompt } from '../src/bridge/prompt.ts'
import { PeerSessions, type AgentHandleLike, type AgentRegistryLike } from '../src/bridge/session.ts'
import { PeerGenerations } from '../src/bridge/generations.ts'
import { PeerMemory } from '../src/bridge/memory.ts'
import { ReplyQueue } from '../src/bridge/reply.ts'
import { createMediaPreparer } from '../src/bridge/media.ts'
import { createAccessPolicy } from '../src/bridge/access.ts'
import { PersonaStore } from '../src/persona/store.ts'
import { ChatSettingsStore } from '../src/persona/settings.ts'
import { StickerLibrary } from '../src/persona/stickers.ts'
import type { ApiClient } from '../src/ilink/api.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-conversation-'))
  const ctx = new Context()
  new SystemPrompt(ctx, { personaSuffix: '宿主工具规则' })
  for (const [id, name] of [['alpha', '甲'], ['beta', '乙']]) {
    await mkdir(join(root, 'personas', id!), { recursive: true })
    await writeFile(join(root, 'personas', id!, 'persona.json'), JSON.stringify({ id, name, prompt: { identity: `你是${name}` } }))
  }
  const personas = new PersonaStore(join(root, 'personas'))
  const settings = new ChatSettingsStore(join(root, 'chats'))
  const memory = new PeerMemory(join(root, 'memories.json'))
  const stickers = new StickerLibrary(join(root, 'stickers'))
  const prompts = new PeerSystemPrompt({ personas, settings, memory, stickers, defaultPersona: () => 'alpha' })
  const live = new Map<string, AgentHandleLike['agent']>()
  const persisted = new Set<string>()
  const routes: string[] = []
  const requestWork: Promise<void>[] = []
  const requests: { id: string; system: string; message: { role: string; source: unknown; content: { type: string; text?: string }[] } }[] = []
  async function makeAgent(id: string, setup?: (ctx: unknown, agent: unknown) => Promise<void> | void): Promise<AgentHandleLike> {
    const agent = { id, ctx: undefined as unknown as Context, followup(message: never) {
      requestWork.push(ctx.systemPrompt.assemble({ scope: agent, agent: agent as never }).then(assembly => {
        requests.push({ id, system: renderPrompt(assembly), message })
      }))
    } }
    const scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    await setup?.(scope.ctx, agent)
    live.set(id, agent as never)
    persisted.add(id)
    return { agent: agent as never, dispose: async () => { live.delete(id); await scope.dispose() } }
  }
  const registry: AgentRegistryLike = {
    create: async options => { routes.push('create'); return await makeAgent(options.sessionId, options.setup) },
    resume: async options => { routes.push('resume'); return await makeAgent(options.resumeSessionId, options.setup) },
    get: id => live.get(id),
  }
  const sessions = new PeerSessions({ registry, cwd: root, sessionExists: async id => persisted.has(id),
    setup: (agentCtx, agent, peerId) => { prompts.install(agentCtx as Context, agent as object, peerId) },
    onHandle: (handle, peerId) => { prompts.install(handle.agent.ctx!, handle.agent, peerId) },
  })
  const sends: string[] = []
  const replies = new ReplyQueue({
    send: async (_peer, text) => { sends.push(text) },
    sendSticker: async (peerId, name) => {
      const file = await stickers.find(name, peerId)
      if (file === undefined) return false
      assert.ok((await readFile(file)).length > 0)
      sends.push('图片:' + name)
      return true
    }, sleep: async () => {},
  })
  let listener: ((session: { id: unknown }, event: unknown) => void) | undefined
  const png = PNG.sync.write({ width: 1, height: 1, data: Buffer.from([255, 0, 0, 255]) } as PNG)
  const prepareMedia = createMediaPreparer({
    download: async () => png, supportsImage: async () => true,
    onImage: async ({ data, mediaType, peerId }) => (await stickers.capture(peerId!, data, mediaType))?.id,
    store: { saveImages: async inputs => inputs.map((_, index) => ({ id: `image-${index}` })), saveFile: async () => ({ id: 'file' }) },
  })
  const channel = new Channel({ api: {} as ApiClient, account: { baseUrl: 'https://api', token: 't' }, sessions,
    access: createAccessPolicy({ owner: 'u1' }), personas, settings, memory, stickers, defaultPersona: 'alpha', replies,
    generations: new PeerGenerations(join(root, 'generations.json')), prepareMedia,
    events: { on: (_event, next) => { listener = next; return () => { listener = undefined } } },
    mergeWindowMs: 0, progressAfterMs: 0,
  })
  let messageId = 0
  async function send(text: string, image = false) {
    await channel.handle({ message_id: String(++messageId), from_user_id: 'u1', message_type: 1, context_token: `t${messageId}`,
      item_list: [...(text === '' ? [] : [{ type: 1, text_item: { text } }]), ...(image ? [{ type: 2, image_item: { media: { full_url: 'https://cdn/image' } } }] : [])] })
    await Promise.all(requestWork)
  }
  const answer = (id: string, text: string) => listener?.({ id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  t.after(async () => { await channel.stop(); prompts.dispose(); await rm(root, { recursive: true, force: true }) })
  return { channel, sessions, prompts, registry, makeAgent, requests, routes, stickers, sends, send, answer }
}

describe('对话边界与实际组装', () => {
  it('每轮只有微信原文；中文切人格和新对话改变 system 而非伪造用户消息', async t => {
    const f = await fixture(t)
    await f.send('在吗')
    await f.send('人格 beta')
    await f.send('你好')
    await f.send('新对话')
    await f.send('再聊点别的')
    assert.deepEqual(f.requests.map(request => request.message.content), [
      [{ type: 'text', text: '在吗' }], [{ type: 'text', text: '你好' }], [{ type: 'text', text: '再聊点别的' }],
    ])
    for (const request of f.requests) { assert.equal(request.message.role, 'user'); assert.deepEqual(request.message.source, { kind: 'user' }); assert.match(request.system, /宿主工具规则/) }
    assert.match(f.requests[0]!.system, /你是甲/)
    assert.match(f.requests[1]!.system, /你是乙/)
    assert.match(f.requests[2]!.system, /你是乙/)
    assert.equal(f.requests[2]!.id, 'channel-persona-u1~g1')
    await f.sessions.release('u1', 1)
    await f.send('恢复对话')
    assert.ok(f.routes.includes('resume'))
    assert.match(f.requests.at(-1)!.system, /你是乙/)
  })

  it('纯图片只有附件；识别结果持久化后按文字、图片、文字的顺序分条发送', async t => {
    const f = await fixture(t)
    await f.send('', true)
    assert.deepEqual(f.requests[0]!.message.content, [{ type: 'image', attachment: { id: 'image-0' } }])
    const image = (await f.stickers.catalog('u1'))[0]!
    assert.match(f.requests[0]!.system, new RegExp(image.id))
    f.answer(f.requests[0]!.id, `哈哈[分条][表情:${image.id}]笑死了[收录表情:${image.id}|开心|红色小猫笑|开心和调侃]`)
    await f.channel.whenIdle()
    assert.deepEqual(f.sends, ['哈哈', '图片:' + image.id, '笑死了'])
    await f.send('嗯')
    assert.match(f.requests.at(-1)!.system, /开心和调侃/)
    f.answer(f.requests.at(-1)!.id, '嗯。')
    await f.channel.whenIdle()
    assert.equal(f.sends.at(-1), '嗯。')
    assert.equal(f.sends.filter(text => text === '嗯。').length, 1)
  })

  it('借用 GUI 已启动的会话也挂载人格，停止通道不销毁别人的会话', async t => {
    const f = await fixture(t)
    const borrowed = await f.makeAgent('channel-persona-u1')
    await f.send('你好')
    assert.deepEqual(f.routes, [])
    assert.match(f.requests[0]!.system, /你是甲/)
    await f.channel.stop()
    assert.ok(f.registry.get('channel-persona-u1' as never))
    await borrowed.dispose()
  })
})

describe('宿主缺少 systemPrompt 服务', () => {
  it('跳过人设并报告，不打断会话创建', () => {
    const bare = new Context()
    const reports: string[] = []
    const prompts = new PeerSystemPrompt({
      personas: new PersonaStore('/nonexistent-personas'),
      settings: new ChatSettingsStore('/nonexistent-chats'),
      memory: new PeerMemory('/nonexistent-memory.json'),
      stickers: new StickerLibrary('/nonexistent-stickers'),
      defaultPersona: () => 'default',
      report: line => { reports.push(line) },
    })
    assert.doesNotThrow(() => { prompts.install(bare, { id: 'agent' }, 'peer') })
    assert.equal(reports.length, 1)
    assert.match(reports[0] ?? '', /systemPrompt/)
  })
})
