/** Behavioral regressions from the design audit; no live WeChat or model is used. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { Channel, type ChannelOptions } from '../../src/wechat/channel.ts'
import { ConversationStore } from '../../src/chat/history.ts'
import { PeerGenerations } from '../../src/chat/generations.ts'
import { PeerSessions, sessionIdFor, type AgentHandleLike } from '../../src/dsh/sessions.ts'
import { PersonaStore } from '../../src/persona/store.ts'
import { createAccessPolicy } from '../../src/wechat/access.ts'
import { ReplyQueue, type ReplyQueueOptions } from '../../src/reply/queue.ts'
import type { ApiClient } from '../../src/ilink/api.ts'

function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
async function fixture(t: TestContext, options: { channel?: Partial<ChannelOptions>; queue?: Partial<ReplyQueueOptions>; claimSteering?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-lifecycle-'))
  const history = new ConversationStore(join(root, 'history'))
  let listener: ((session: { id: unknown }, event: unknown) => void) | undefined
  const sent: string[] = [], delivered: { id: string; mode: string; text: string; content: unknown[] }[] = []
  const agents = new Map<string, { agent: AgentHandleLike['agent']; turn: number }>()
  const emit = (id: string, type: string, data: unknown) => listener?.({ id }, { type, data })
  const registry = {
    get: (id: string) => agents.get(id)?.agent,
    create: async ({ sessionId }: { sessionId: string }) => {
      const state = { turn: 0, agent: undefined as unknown as AgentHandleLike['agent'] }
      const agent = { id: sessionId, status: 'idle' as 'idle' | 'running',
        followup: (message: never) => consume(message, 'followup'),
        steer: (message: never) => consume(message, 'steer'),
        cancel: () => { agent.status = 'idle'; emit(sessionId, 'turn/end', { turn: state.turn, reason: { kind: 'aborted' } }) },
      }
      function consume(message: { id: string; content: { type: string; text?: string }[] }, mode: string) {
        delivered.push({ id: message.id, mode, text: message.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n'), content: message.content })
        if (mode === 'followup') { agent.status = 'running'; state.turn++; emit(sessionId, 'turn/start', { turn: state.turn }) }
        if (mode === 'followup' || options.claimSteering !== false) emit(sessionId, 'user/message', message)
      }
      state.agent = agent as never; agents.set(sessionId, state)
      return { agent: agent as never, dispose: async () => { agents.delete(sessionId) } }
    }, resume: async () => { throw new Error('unexpected resume') },
  }
  const sessions = new PeerSessions({ registry: registry as never, cwd: root })
  const replies = new ReplyQueue({ history, send: async (_peer, text) => { sent.push(text) }, sendFile: async (_peer, path) => { sent.push('文件:' + path) }, sendSticker: async (_peer, name) => { sent.push('图片:' + name); return true }, sleep: async () => {}, ...options.queue })
  const channel = new Channel({ api: {} as ApiClient, account: { baseUrl: 'https://invalid', token: 'synthetic' }, sessions, history,
    access: createAccessPolicy({ allow: 'u1,u2' }), personas: new PersonaStore(join(root, 'personas')), defaultPersona: 'default', replies,
    events: { on: (_event, fn) => { listener = fn; return () => { listener = undefined } } },
    generations: new PeerGenerations(join(root, 'generations.json')), mergeWindowMs: 0, ...options.channel })
  let counter = 0
  async function send(text: string, peer = 'u1', items?: unknown[], receiveOnly = false) {
    await channel.handle({ message_id: String(++counter), from_user_id: peer, message_type: 1, context_token: `t${counter}`,
      item_list: items ?? [{ type: 1, text_item: { text } }] }, receiveOnly)
  }
  let answerId = 0
  function answer(text: string, generation = 0, peer = 'u1', turn = 1) {
    emit(sessionIdFor(peer, generation), 'assistant/message', { turn, step: 1, message: { id: `answer-${++answerId}`, content: [{ type: 'text', text }] } })
  }
  t.after(async () => { await channel.stop(); await rm(root, { recursive: true, force: true }) })
  return { root, channel, history, replies, sessions, send, answer, emit, sent, delivered, agents }
}

describe('对话生命周期', () => {
  it('运行中的补充在下一步骤处理，不排成互相独立的请求', async t => {
    const f = await fixture(t)
    await f.send('帮我写邮件'); await f.send('先给草稿，别发送')
    assert.deepEqual(f.delivered.map(message => message.mode), ['followup', 'steer'])
    assert.equal(f.delivered[1]!.text, '先给草稿，别发送')
  })
  it('新补充尚未被消费时，旧模型回答不能提前发出', async t => {
    const f = await fixture(t, { claimSteering: false })
    await f.send('帮我写邮件'); await f.send('只写草稿')
    f.answer('已经发出了'); await f.channel.whenIdle(); assert.deepEqual(f.sent, [])
    f.emit(sessionIdFor('u1'), 'user/message', { id: f.delivered[1]!.id })
    f.answer('这是草稿'); await f.channel.whenIdle(); assert.deepEqual(f.sent, ['这是草稿'])
  })
  it('停止撤销待发气泡，并且只给一次停止反馈', async t => {
    const entered = gate(), release = gate(), sent: string[] = []
    const f = await fixture(t, { queue: { send: async (_peer, text) => { sent.push(text); if (text === '第一条') { entered.resolve(); await release.promise } } } })
    await f.send('解释一下'); f.answer('第一条[分条]第二条[分条]第三条'); await entered.promise
    await f.send('停止'); release.resolve(); await f.channel.whenIdle()
    assert.equal(sent.filter(text => text.includes('已停止')).length, 1)
    assert.ok(!sent.includes('第二条') && !sent.includes('第三条'))
    const history = await f.history.history('u1')
    assert.ok(history.deliveries.some(unit => unit.value === '第二条' && unit.status === 'cancelled'))
  })
  it('新对话使旧会话的迟到回答和文件失效', async t => {
    const f = await fixture(t)
    await f.send('旧任务'); await f.send('新对话'); await f.send('新话题')
    f.answer('旧回答', 0)
    f.emit(sessionIdFor('u1'), 'deliverables/presented', { files: [{ path: '/old.pdf' }] })
    f.answer('新回答', 1); await f.channel.whenIdle()
    assert.ok(f.sent.includes('新回答')); assert.ok(!f.sent.includes('旧回答')); assert.ok(!f.sent.includes('文件:/old.pdf'))
  })
  it('下载慢的图片不能被后发文字超越，另一联系人独立处理', async t => {
    const entered = gate(), release = gate()
    const f = await fixture(t, { channel: { prepareMedia: async items => { if (items.some(item => item.type === 2)) { entered.resolve(); await release.promise } return { parts: [{ type: 'image', attachment: { id: 'img' } }], notes: [] } } } })
    await f.send('', 'u1', [{ type: 2 }], true); await entered.promise
    await f.send('后发补充', 'u1', undefined, true)
    await f.send('另一个人的话', 'u2')
    assert.equal(f.delivered[0]!.text, '另一个人的话')
    release.resolve(); await f.channel.whenIdle()
    assert.equal((f.delivered[1]!.content[0] as { type: string }).type, 'image')
    assert.equal(f.delivered[2]!.text, '后发补充')
  })
  it('原始文字和附件顺序保留', async t => {
    const f = await fixture(t, { channel: { prepareMedia: async () => ({ parts: [{ type: 'image', attachment: { id: 'img' } }], notes: [] }) } })
    await f.send('', 'u1', [{ type: 1, text_item: { text: '图前' } }, { type: 2 }, { type: 1, text_item: { text: '图后' } }])
    assert.deepEqual(f.delivered[0]!.content.map(item => (item as { type: string }).type), ['text', 'image', 'text'])
  })
  it('文字、文件、表情按事件与正文顺序发送', async t => {
    const f = await fixture(t)
    await f.send('给我文件')
    f.answer('说明在前[表情:开心]')
    f.emit(sessionIdFor('u1'), 'deliverables/presented', { turn: 1, files: [{ path: '/out.pdf' }] })
    f.answer('附件在上面')
    await f.channel.whenIdle()
    assert.deepEqual(f.sent, ['说明在前', '图片:开心', '文件:/out.pdf', '附件在上面'])
  })
  it('发送失败有真实结果，下次上下文不会声称已发出', async t => {
    const f = await fixture(t, { queue: { send: async () => { throw new Error('network') }, maxAttempts: 1 } })
    await f.send('你好'); f.answer('未送达'); await f.channel.whenIdle()
    const state = await f.channel.context('u1')
    assert.match(state, /unknown/); assert.match(state, /未送达/)
  })
  it('发送失败会告知用户；重试只重发原回答，不重新运行模型', async t => {
    let fail = true
    const accepted: string[] = []
    const f = await fixture(t, { queue: { send: async (_peer, text) => { if (fail && text === '保存好的回答') throw new Error('network'); accepted.push(text) }, maxAttempts: 1 } })
    await f.send('你好'); f.answer('保存好的回答'); await f.channel.whenIdle()
    assert.ok(accepted.some(text => text.includes('发送结果未确认')), JSON.stringify(accepted))
    const modelCalls = f.delivered.length
    fail = false
    await f.send('重试'); await f.channel.whenIdle()
    assert.equal(accepted.filter(text => text === '保存好的回答').length, 1)
    assert.equal(f.delivered.length, modelCalls, '重试不得再投给模型')
    assert.ok(accepted.some(text => text.includes('重新发送')), JSON.stringify(accepted))
  })


  it('重试只补发仍未确认的气泡，已补发成功的不再重复', async t => {
    const accepted: string[] = []
    let phase: 'initial' | 'retry' | 'done' = 'initial'
    const f = await fixture(t, { queue: { maxAttempts: 1, send: async (_peer, text) => {
      if (phase === 'initial') throw new Error('network')
      if (phase === 'retry' && text === '第二段') throw new Error('network')
      if (text === '第一段' || text === '第二段') accepted.push(text)
    } } })
    await f.send('你好'); f.answer('第一段[分条]第二段'); await f.channel.whenIdle()
    assert.deepEqual(accepted, [])
    phase = 'retry'
    await f.send('重试'); await f.channel.whenIdle()
    assert.deepEqual(accepted, ['第一段'])
    phase = 'done'
    await f.send('重试'); await f.channel.whenIdle()
    assert.deepEqual(accepted, ['第一段', '第二段'], '第二次重试不该再发第一段')
  })


  it('回答与提示都被限流时，把失败写进上下文而不是静默', async t => {
    const f = await fixture(t, { queue: {
      maxAttempts: 1, maxThrottleAttempts: 1,
      send: async () => { throw Object.assign(new Error('throttled'), { code: -2 }) },
    } })
    await f.send('你好'); f.answer('发不出去的回答'); await f.channel.whenIdle()
    const state = await f.channel.context('u1')
    assert.match(state, /发不出去的回答/, state)
    assert.match(state, /未能送达用户的提示/, state)
  })

  it('没有可重试的回答时明确说明', async t => {
    const f = await fixture(t)
    await f.send('重试'); await f.channel.whenIdle()
    assert.ok(f.sent.some(text => text.includes('没有需要重发')), JSON.stringify(f.sent))
  })

  it('压缩等待不阻塞接收，停止能够取消压缩', async t => {
    const entered = gate(), cancelled = gate()
    const f = await fixture(t, { channel: { compact: async (_peer, _generation, signal) => { entered.resolve(); await new Promise<void>(resolve => { signal!.addEventListener('abort', () => { cancelled.resolve(); resolve() }, { once: true }) }); return { kind: 'cancelled' } } } })
    await f.send('压缩'); await entered.promise
    await f.send('停止'); await cancelled.promise; await f.send('新消息'); await f.channel.whenIdle()
    assert.equal(f.delivered.at(-1)!.text, '新消息')
    assert.ok(!f.sent.some(text => text.includes('压缩被取消')))
  })
  it('相同入站 ID 在进程重启后仍去重，且联系人之间隔离', async t => {
    const f = await fixture(t)
    await f.send('你好')
    const history = new ConversationStore(join(f.root, 'history'))
    const duplicate = await history.receive('u1', 0, { message_id: '1' }, '你好', Date.now())
    assert.equal(duplicate.fresh, false)
    assert.equal((await history.receive('u2', 0, { message_id: '1' }, '另一个人', Date.now())).fresh, true)
  })
  it('压缩后任务目标、约束和待确认事项仍在独立上下文中', async t => {
    const f = await fixture(t, { channel: { compact: async () => ({ kind: 'done', shadowed: 4, tokens: 100 }) } })
    await f.send('写邮件，只给草稿')
    await f.history.saveTask('u1', { generation: 0, goal: '写邮件', constraints: ['只给草稿，不发送'], completed: ['确认主题'], pending: ['写正文'], waitingFor: '收件人称呼' }, new AbortController().signal)
    f.emit(sessionIdFor('u1'), 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    await f.send('压缩'); await f.channel.whenIdle()
    assert.match(await f.channel.context('u1'), /只给草稿，不发送/)
    await f.send('新对话'); assert.doesNotMatch(await f.channel.context('u1'), /只给草稿，不发送/)
  })
})
