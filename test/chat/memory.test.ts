/**
 * 跨会话记忆：标记要摘干净，事实要真的能存回来。
 */

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { extractMemoryMarkers, MAX_FACTS, PeerMemory } from '../../src/chat/memory.ts'

describe('extractMemoryMarkers', () => {
  it('摘掉标记，返回事实', () => {
    const result = extractMemoryMarkers('好的，记下了。[记住: 用户叫阿彬]')
    assert.equal(result.text, '好的，记下了。')
    assert.deepEqual(result.facts, ['用户叫阿彬'])
  })

  it('支持全角冒号和一条消息里多条', () => {
    const result = extractMemoryMarkers('嗯。[记住：做前端][记住：住在杭州]')
    assert.equal(result.text, '嗯。')
    assert.deepEqual(result.facts, ['做前端', '住在杭州'])
  })

  it('没有标记时原样返回', () => {
    const result = extractMemoryMarkers('普通回复')
    assert.equal(result.text, '普通回复')
    assert.deepEqual(result.facts, [])
  })

  it('空标记被忽略，但依然从正文里删掉', () => {
    const result = extractMemoryMarkers('a[记住:   ]b')
    assert.equal(result.text, 'ab')
    assert.deepEqual(result.facts, [])
  })

  it('超长事实被截断', () => {
    const result = extractMemoryMarkers(`[记住: ${'x'.repeat(300)}]`)
    assert.equal(result.facts[0]?.length, 120)
  })
})

describe('PeerMemory', () => {
  async function store() {
    const dir = await mkdtemp(join(tmpdir(), 'memory-'))
    const memory = new PeerMemory(join(dir, 'memories.json'))
    await memory.load()
    return memory
  }

  it('记住之后能读回，重开还在', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-reload-'))
    const file = join(dir, 'memories.json')
    const first = new PeerMemory(file)
    await first.load()
    await first.remember('wxid-a', ['用户叫阿彬', '喜欢简短'])
    const second = new PeerMemory(file)
    await second.load()
    assert.deepEqual(second.get('wxid-a'), ['用户叫阿彬', '喜欢简短'])
  })

  it('重复事实只存一次', async () => {
    const memory = await store()
    await memory.remember('p', ['同名'])
    await memory.remember('p', ['同名', '另一个'])
    assert.deepEqual(memory.get('p'), ['同名', '另一个'])
  })

  it('超过上限时丢最早的', async () => {
    const memory = await store()
    const facts = Array.from({ length: MAX_FACTS + 5 }, (_, index) => `事实${String(index)}`)
    await memory.remember('p', facts)
    const kept = memory.get('p')
    assert.equal(kept.length, MAX_FACTS)
    assert.equal(kept[0], '事实5')
  })

  it('清空只影响这个聊天', async () => {
    const memory = await store()
    await memory.remember('a', ['x'])
    await memory.remember('b', ['y'])
    await memory.clear('a')
    assert.deepEqual(memory.get('a'), [])
    assert.deepEqual(memory.get('b'), ['y'])
  })

  it('注入行有长度上限', async () => {
    const memory = await store()
    await memory.remember('p', ['x'.repeat(120), 'y'.repeat(120)])
    const line = memory.lineFor('p', 50)
    assert.ok((line ?? '').length <= 51)
  })

  it('没有记忆时不产生注入行', async () => {
    const memory = await store()
    assert.equal(memory.lineFor('nobody'), undefined)
  })
})
