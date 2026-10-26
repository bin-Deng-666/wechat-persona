import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { ConversationStore } from '../../src/chat/history.ts'
import { PeerMemory } from '../../src/memory/store.ts'
import { MemoryCapture, type MemoryActivity, type MemoryWrite } from '../../src/memory/capture.ts'
import { createProposal } from '../../src/memory/model.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-memory-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const memory = new PeerMemory(join(root, 'memory')); await memory.load()
  const history = new ConversationStore(join(root, 'conversations'))
  let current: MemoryActivity | undefined
  const capture = new MemoryCapture(memory, history, 'u1', () => current)
  async function source(text: string, id = String(Math.random()), peerId = 'u1') {
    const input = (await history.receive(peerId, 0, { message_id: id, from_user_id: peerId, item_list: [{ type: 1, text_item: { text } }] }, text, Date.now())).record
    const controller = new AbortController()
    current = { id, generation: 0, inputIds: [input.id], signal: controller.signal }
    return { input, controller }
  }
  const write = (entryId: string, quote: string, extra: Partial<MemoryWrite> = {}) => capture.write({ action: 'add', entryId, quote, title: '回答偏好', content: '用户希望回答简短直接', type: '稳定偏好', certainty: '明确', scope: '日常沟通', tags: ['回答'], reason: '未来回答可据此调整详略', ...extra }, new AbortController().signal)
  return { root, history, memory, capture, source, write }
}

describe('有来源的微信记忆', () => {
  it('写入必须先检索，且必须逐字引用当前用户来源', async t => {
    const f = await fixture(t), { input } = await f.source('我希望回答简短直接')
    await assert.rejects(f.write(input.id, input.text), /先使用/)
    f.capture.search('回答')
    await assert.rejects(f.write('invented-id', input.text), /证据/)
    await assert.rejects(f.write(input.id, '我最喜欢英语'), /证据/)
    const saved = await f.write(input.id, input.text)
    assert.equal(saved.version, 1)
    assert.equal(f.memory.get('u1')[0]!.sources[0]!.quote, input.text)
    assert.equal(f.memory.get('u2').length, 0)
  })
  it('其他联系人、历史消息和助手文字不能冒充本轮证据', async t => {
    const f = await fixture(t), old = await f.source('我住北京', 'old')
    const other = await f.source('我住上海', 'other', 'u2')
    await f.source('今天聊工作', 'current'); f.capture.search('住')
    await assert.rejects(f.write(old.input.id, old.input.text), /证据/)
    await assert.rejects(f.write(other.input.id, other.input.text), /证据/)
  })
  it('更新要求检索确切版本、明确纠正，并保留旧证据', async t => {
    const f = await fixture(t), first = await f.source('我希望回答简短直接', 'first')
    f.capture.search('回答'); const saved = await f.write(first.input.id, first.input.text)
    const next = await f.source('纠正一下，我现在偏好先解释再给结论', 'next')
    f.capture.search('不匹配关键词')
    await assert.rejects(f.write(next.input.id, next.input.text, { action: 'update', targetId: saved.id, targetVersion: 1 }), /最新 ID/)
    f.capture.search('', saved.id)
    const updated = await f.write(next.input.id, next.input.text, { action: 'update', targetId: saved.id, targetVersion: 1, content: '用户现在偏好先解释再给结论' })
    assert.equal(updated.version, 2)
    assert.equal(f.memory.get('u1')[0]!.sources.length, 2)
    await assert.rejects(f.write(next.input.id, next.input.text, { action: 'update', targetId: saved.id, targetVersion: 1 }), /已变化/)
  })
  it('没有更正依据时保留原记忆', async t => {
    const f = await fixture(t), first = await f.source('我希望回答简短直接', 'first')
    f.capture.search('回答'); const saved = await f.write(first.input.id, first.input.text)
    const next = await f.source('今天这篇文章写长一点', 'next'); f.capture.search('', saved.id)
    await assert.rejects(f.write(next.input.id, next.input.text, { action: 'update', targetId: saved.id, targetVersion: 1 }), /明确纠正/)
    assert.equal(f.memory.get('u1')[0]!.version, 1)
  })
  it('删除只接受当前明确请求，删除后相同内容不会自动重建', async t => {
    const f = await fixture(t), first = await f.source('我希望回答简短直接', 'first')
    f.capture.search('回答'); const saved = await f.write(first.input.id, first.input.text)
    const next = await f.source('忘记我关于回答长度的偏好', 'next'); f.capture.search('', saved.id)
    await assert.rejects(f.write(next.input.id, next.input.text, { action: 'delete', targetId: saved.id, targetVersion: 1 }), /明确/)
    await f.write(next.input.id, next.input.text, { action: 'delete', targetId: saved.id, targetVersion: 1, explicitRequestQuote: next.input.text })
    assert.equal(f.memory.get('u1').length, 0)
    const again = await f.source('我希望回答简短直接', 'again'); f.capture.search('回答')
    await assert.rejects(f.write(again.input.id, again.input.text), /已被删除/)
  })
  it('当前请求取消后禁止迟到的写入', async t => {
    const f = await fixture(t), { input, controller } = await f.source('我希望回答简短直接')
    f.capture.search('回答'); controller.abort()
    await assert.rejects(f.write(input.id, input.text), /没有可写入/)
    assert.equal(f.memory.get('u1').length, 0)
  })
  it('明显的项目任务和无证据的服务名被过滤', async t => {
    const f = await fixture(t), { input } = await f.source('这个项目的代码改成三层模块')
    f.capture.search('代码')
    await assert.rejects(f.write(input.id, input.text, { title: '项目开发安排', content: '下一阶段重构数据层', type: '目标与方向' }), /project-specific/)
    await assert.rejects(f.write(input.id, input.text, { content: '用户使用 invented-service.com' }), /domain/)
  })
  it('重启保留证据与版本，删除记录仍生效', async t => {
    const f = await fixture(t), { input } = await f.source('我希望回答简短直接')
    f.capture.search('回答'); await f.write(input.id, input.text)
    const restored = new PeerMemory(join(f.root, 'memory')); await restored.load()
    assert.equal(restored.get('u1')[0]!.sources[0]!.entryId, input.id)
    assert.match(restored.habits('u1'), /简短直接/)
    await restored.clear('u1')
    const reloaded = new PeerMemory(join(f.root, 'memory')); await reloaded.load()
    assert.equal(reloaded.get('u1').length, 0)
  })
  it('按相关度检索，新事实不会被旧事实的字符截断隐藏', async t => {
    const f = await fixture(t)
    for (let i = 0; i < 8; i++) await f.memory.apply('u1', createProposal({ title: `其他事实${i}`, content: '其他信息'.repeat(20) + i, type: '个人背景', sources: [] }))
    await f.memory.apply('u1', createProposal({ title: '居住城市', content: '用户现在住上海', type: '个人背景', tags: ['城市', '上海'], sources: [] }))
    assert.equal(f.memory.search('u1', '上海')[0]!.content, '用户现在住上海')
    assert.doesNotMatch(f.memory.habits('u1'), /上海/)
  })
  it('旧版无来源记忆保留为未核实资料，不自动注入', async t => {
    const f = await fixture(t)
    await writeFile(join(f.root, 'memories.json'), JSON.stringify({ old: ['用户住北京'] }))
    const migrated = new PeerMemory(join(f.root, 'migrated')); await migrated.load()
    assert.deepEqual(migrated.legacy('old'), ['用户住北京'])
    assert.equal(migrated.get('old').length, 0); assert.equal(migrated.habits('old'), '')
    assert.match(await readFile(join(f.root, 'memories.json'), 'utf8'), /北京/)
  })
  it('损坏文件不会被空库覆盖', async t => {
    const f = await fixture(t)
    await writeFile(join(f.root, 'memories.json'), '{broken')
    const next = new PeerMemory(join(f.root, 'new-memory'))
    await assert.rejects(next.load())
    assert.equal(await readFile(join(f.root, 'memories.json'), 'utf8'), '{broken')
  })
})
