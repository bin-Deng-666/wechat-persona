/**
 * 活跃时间落盘：重启后「安静了多久」不能归零。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { PeerActivity } from '../../src/chat/activity.ts'

describe('PeerActivity', () => {
  it('touch 之后能读回，落盘后重开还在', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'activity-'))
    const file = join(dir, 'last-seen.json')
    const first = new PeerActivity(file)
    first.touch('wxid-a', 1_700_000_000_000)
    await first.flush()

    const second = new PeerActivity(file)
    await second.load()
    assert.equal(second.get('wxid-a'), 1_700_000_000_000)
    assert.deepEqual(second.peers(), ['wxid-a'])
  })

  it('文件不存在时是空表，不抛错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'activity-empty-'))
    const store = new PeerActivity(join(dir, 'last-seen.json'))
    await store.load()
    assert.equal(store.get('nobody'), undefined)
    assert.deepEqual(store.peers(), [])
  })

  it('文件损坏时当作空表', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'activity-broken-'))
    const file = join(dir, 'last-seen.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, 'not json', 'utf8')
    const store = new PeerActivity(file)
    await store.load()
    assert.deepEqual(store.peers(), [])
  })

  it('非数字条目被丢掉，不让坏数据变成 NaN 判定', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'activity-mixed-'))
    const file = join(dir, 'last-seen.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, JSON.stringify({ good: 123, bad: 'yesterday', alsoBad: null }), 'utf8')
    const store = new PeerActivity(file)
    await store.load()
    assert.equal(store.get('good'), 123)
    assert.equal(store.get('bad'), undefined)
  })

  it('写盘是 JSON 对象，便于人看', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'activity-shape-'))
    const file = join(dir, 'last-seen.json')
    const store = new PeerActivity(file)
    store.touch('wxid-a', 42)
    await store.flush()
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, number>
    assert.deepEqual(raw, { 'wxid-a': 42 })
  })
})
