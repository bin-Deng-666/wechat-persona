import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ReplyQueue } from '../../src/reply/queue.ts'
import { ConversationStore, type DeliveryUnit } from '../../src/chat/history.ts'
import { createApiClient } from '../../src/ilink/api.ts'

const unit = (status: DeliveryUnit['status'], id: string): DeliveryUnit => ({ id, peerId: 'u1', generation: 0, activityId: 'a', groupId: 'g', kind: 'text', value: id, status, createdAt: Date.now() })
describe('真实的交付结果与恢复', () => {
  it('同一逻辑消息跨网络重试复用 client_id', async () => {
    const ids: string[] = []
    const api = createApiClient({ fetchImpl: async (_url, init) => {
      ids.push((JSON.parse(init!.body as string) as { msg: { client_id: string } }).msg.client_id)
      if (ids.length === 1) throw new Error('lost response')
      return new Response('{"ret":0}')
    } })
    const queue = new ReplyQueue({ send: async (peerId, text, _token, context) => await api.sendText({ baseUrl: 'https://invalid', endpoint: '/send', label: 'test', token: 'synthetic', to: peerId, text, clientId: context.clientId, signal: context.signal }), sleep: async () => {} })
    const result = await queue.enqueue('u1', '你好')
    assert.equal(result.status, 'accepted'); assert.equal(ids.length, 2); assert.equal(ids[0], ids[1])
  })
  it('部分成功的回答不伪装成完整送达，失败后的正文取消', async () => {
    const queue = new ReplyQueue({ send: async (_peer, text) => { if (text === '二') throw Object.assign(new Error('rejected'), { code: 400 }) }, sleep: async () => {} })
    const result = await queue.enqueue('u1', '一[分条]二[分条]三')
    assert.equal(result.status, 'partial')
    assert.deepEqual(result.units.map(unit => unit.status), ['accepted', 'failed', 'cancelled'])
  })
  it('发送回执丢失为 unknown，服务端明确拒绝为 failed', async () => {
    const unknown = new ReplyQueue({ send: async () => { throw new Error('network timeout') }, maxAttempts: 1 })
    const rejected = new ReplyQueue({ send: async () => { throw Object.assign(new Error('not allowed'), { code: -14 }) } })
    assert.equal((await unknown.enqueue('u1', 'a')).status, 'unknown')
    assert.equal((await rejected.enqueue('u1', 'b')).status, 'failed')
  })
  it('正在发送的记录在重启后结果不明，待发的旧回答取消，不盲目重发', async t => {
    const root = await mkdtemp(join(tmpdir(), 'wechat-outbox-')); t.after(async () => { await rm(root, { recursive: true, force: true }) })
    const history = new ConversationStore(root)
    await history.saveDelivery(unit('accepted', 'already-accepted'))
    await history.saveDelivery(unit('sending', 'response-lost'))
    await history.saveDelivery(unit('pending', 'not-sent'))
    const sends: string[] = []
    const queue = new ReplyQueue({ history: new ConversationStore(root), send: async (_peer, text) => { sends.push(text) } })
    await queue.recover()
    const restored = await new ConversationStore(root).history('u1')
    assert.deepEqual(restored.deliveries.map(unit => unit.status), ['accepted', 'unknown', 'cancelled'])
    assert.deepEqual(sends, [])
  })
  it('重试成功后原未确认单元被收口，不会再次补发', async t => {
    const root = await mkdtemp(join(tmpdir(), 'wechat-outbox-')); t.after(async () => { await rm(root, { recursive: true, force: true }) })
    const history = new ConversationStore(root)
    await history.saveDelivery({ ...unit('unknown', 'a'), groupId: 'g1', value: '原回答' })
    await history.saveDelivery({ ...unit('accepted', 'b'), groupId: 'g1', value: '后半句' })
    let fail = true
    const queue = new ReplyQueue({ history, send: async (_peer, text) => { if (fail) throw new Error('network') }, maxAttempts: 1 })
    const first = await queue.enqueue('u1', '原回答', undefined, undefined, { groupId: 'g1' })
    assert.equal(first.status, 'unknown')
    fail = false
    const retry = await queue.enqueue('u1', '原回答', undefined, undefined, { groupId: 'g1:retry:1' })
    assert.equal(retry.status, 'accepted')
    const state = await history.history('u1')
    assert.equal(state.deliveries.find(item => item.id === 'a')?.status, 'unknown')
    assert.equal(state.deliveries.find(item => item.id === 'b')?.status, 'accepted')
  })
  it('前一条正在传输时，后一条排队消息也已持久化', async t => {
    const root = await mkdtemp(join(tmpdir(), 'wechat-outbox-')); t.after(async () => { await rm(root, { recursive: true, force: true }) })
    const history = new ConversationStore(root)
    let release!: () => void, entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const queue = new ReplyQueue({ history, send: async (_peer, text) => { if (text === 'first') { entered(); await gate } } })
    const first = queue.enqueue('u1', 'first'); await started
    const second = queue.enqueue('u1', 'second')
    const pending = await history.history('u1')
    assert.ok(pending.deliveries.some(unit => unit.value === 'second' && unit.status === 'pending'))
    release(); await Promise.all([first, second])
  })
})
