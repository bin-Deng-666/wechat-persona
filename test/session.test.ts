/**
 * peer ⇄ 会话映射的测试：假 registry，不启动真实 agent。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PeerSessions, sessionIdFor, SESSION_ID_PREFIX, type AgentHandleLike, type AgentRegistryLike } from '../src/bridge/session.ts'

/** 一个只记账的假 registry。 */
function fakeRegistry(options: { existing?: string[]; live?: Map<string, unknown> } = {}) {
  const created: string[] = []
  const resumed: string[] = []
  const disposed: string[] = []
  const liveAgents = options.live ?? new Map<string, unknown>()

  const handle = (id: string): AgentHandleLike => {
    const agent = { id, followup: () => {} }
    liveAgents.set(id, agent)
    return { agent: agent as never, dispose: async () => { disposed.push(id); liveAgents.delete(id) } }
  }

  const registry: AgentRegistryLike = {
    async create({ sessionId, meta }) {
      if (meta?.cwd === undefined) throw new Error('测试要求 create 必须带 cwd')
      if (liveAgents.has(sessionId)) throw new Error(`session ${sessionId} already live`)
      created.push(sessionId)
      return handle(sessionId)
    },
    async resume({ resumeSessionId }) {
      resumed.push(resumeSessionId)
      return handle(resumeSessionId)
    },
    get: id => liveAgents.get(id) as never,
  }

  return { registry, created, resumed, disposed, liveAgents }
}

describe('sessionIdFor', () => {
  it('前缀固定，且只含安全字符', () => {
    assert.equal(sessionIdFor('wxid_abc-123'), `${SESSION_ID_PREFIX}wxid_abc-123`)
    assert.equal(sessionIdFor('a/b:c@d'), `${SESSION_ID_PREFIX}a-b-c-d`)
  })

  it('同一个 peer 永远映射到同一个会话', () => {
    assert.equal(sessionIdFor('wxid-1'), sessionIdFor('wxid-1'))
    assert.notEqual(sessionIdFor('wxid-1'), sessionIdFor('wxid-2'))
  })
})

describe('PeerSessions', () => {
  it('首次 acquire 会 create，并记录 cwd', async () => {
    const fake = fakeRegistry()
    const sessions = new PeerSessions({ registry: fake.registry, cwd: '/tmp/work' })
    const handle = await sessions.acquire('u1')
    assert.equal(handle.agent.id, sessionIdFor('u1'))
    assert.deepEqual(fake.created, [sessionIdFor('u1')])
  })

  it('同一 peer 第二次 acquire 复用句柄', async () => {
    const fake = fakeRegistry()
    const sessions = new PeerSessions({ registry: fake.registry, cwd: '/tmp/work' })
    const first = await sessions.acquire('u1')
    const second = await sessions.acquire('u1')
    assert.equal(first, second)
    assert.equal(fake.created.length, 1)
  })

  it('已持久化的会话走 resume', async () => {
    const fake = fakeRegistry()
    const sessions = new PeerSessions({
      registry: fake.registry,
      cwd: '/tmp/work',
      sessionExists: async id => id === sessionIdFor('u1'),
    })
    await sessions.acquire('u1')
    assert.deepEqual(fake.resumed, [sessionIdFor('u1')])
    assert.equal(fake.created.length, 0)
  })

  it('已被他人启动的会话直接借用，不 dispose', async () => {
    const live = new Map<string, unknown>([[sessionIdFor('u1'), { id: sessionIdFor('u1') }]])
    const fake = fakeRegistry({ live })
    const sessions = new PeerSessions({ registry: fake.registry, cwd: '/tmp/work' })
    await sessions.acquire('u1')
    await sessions.disposeAll()
    assert.deepEqual(fake.disposed, [])
  })

  it('create 竞态（id 已存在）时退回借用而不是抛错', async () => {
    const fake = fakeRegistry()
    const original = fake.registry.create
    fake.registry.create = async (options) => {
      // 模拟并发：先让别人占住 id，再调用原 create。
      fake.liveAgents.set(options.sessionId, { id: options.sessionId })
      return await original(options)
    }
    const sessions = new PeerSessions({ registry: fake.registry, cwd: '/tmp/work' })
    const handle = await sessions.acquire('u1')
    assert.equal(handle.agent.id, sessionIdFor('u1'))
  })

  it('disposeAll 关掉自己创建的 agent', async () => {
    const fake = fakeRegistry()
    const sessions = new PeerSessions({ registry: fake.registry, cwd: '/tmp/work' })
    await sessions.acquire('u1')
    await sessions.acquire('u2')
    await sessions.disposeAll()
    assert.deepEqual(fake.disposed.sort(), [sessionIdFor('u1'), sessionIdFor('u2')].sort())
    assert.equal(sessions.peers().length, 0)
  })

  it('deliver 在 agent 已消失后重建再投递', async () => {
    const fake = fakeRegistry()
    const sessions = new PeerSessions({ registry: fake.registry, cwd: '/tmp/work' })
    const first = await sessions.acquire('u1')
    // 模拟 agent 被外部关掉。
    fake.liveAgents.delete(sessionIdFor('u1'))
    const delivered: unknown[] = []
    const message = { hello: true }
    fake.registry.create = async ({ sessionId }) => {
      const agent = { id: sessionId, followup: (m: unknown) => { delivered.push(m) } }
      fake.liveAgents.set(sessionId, agent)
      return { agent: agent as never, dispose: async () => {} }
    }
    await sessions.deliver('u1', message as never)
    assert.deepEqual(delivered, [message])
    assert.notEqual(first.agent.id, '')
  })
})


describe('会话句柄回调', () => {
  it('新建与借用的句柄都会触发 onHandle（用于设权限）', async () => {
    const fake = fakeRegistry()
    const seen: string[] = []
    const sessions = new PeerSessions({
      registry: fake.registry,
      cwd: '/tmp/work',
      onHandle: handle => { seen.push(handle.agent.id) },
    })
    await sessions.acquire('u1')
    await sessions.acquire('u2')
    assert.deepEqual(seen, [sessionIdFor('u1'), sessionIdFor('u2')])
  })

  it('借用已有会话时也触发', async () => {
    const live = new Map<string, unknown>([[sessionIdFor('u1'), { id: sessionIdFor('u1') }]])
    const fake = fakeRegistry({ live })
    const seen: string[] = []
    const sessions = new PeerSessions({ registry: fake.registry, cwd: '/tmp/work', onHandle: h => { seen.push(h.agent.id) } })
    await sessions.acquire('u1')
    assert.deepEqual(seen, [sessionIdFor('u1')])
  })
})
