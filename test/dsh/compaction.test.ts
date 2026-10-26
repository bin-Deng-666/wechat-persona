/** 手动压缩的边界：宿主缺失、空历史、忙碌、取消和失败都必须是可判定的结论。 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { compactPeer, type CompactionEngineLike } from '../../src/dsh/compaction.ts'
import type { AgentHandleLike } from '../../src/dsh/sessions.ts'

function handle(options: { maintenance?: boolean } = {}): AgentHandleLike {
  const agent = {
    id: 'channel-persona-u1',
    followup: () => {},
    session: { id: 'channel-persona-u1' },
    ...(options.maintenance === false
      ? {}
      : { runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => await task(new AbortController().signal) }),
  }
  return { agent: agent as never, dispose: async () => {} }
}

function engine(compactNow: CompactionEngineLike['compactNow']): CompactionEngineLike {
  return { compactNow }
}

const agentAt = (value: AgentHandleLike) => async () => value

describe('compactPeer', () => {
  it('宿主没有压缩服务时返回 unavailable', async () => {
    const outcome = await compactPeer({ engine: undefined, agentAt: agentAt(handle()), peerId: 'u1', generation: 0 })
    assert.deepEqual(outcome, { kind: 'unavailable' })
  })

  it('agent 没有 runMaintenance 时不冒险压缩', async () => {
    const outcome = await compactPeer({
      engine: engine(async () => null),
      agentAt: agentAt(handle({ maintenance: false })),
      peerId: 'u1',
      generation: 0,
    })
    assert.deepEqual(outcome, { kind: 'unavailable' })
  })

  it('没有可压缩历史时返回 nothing', async () => {
    const outcome = await compactPeer({ engine: engine(async () => null), agentAt: agentAt(handle()), peerId: 'u1', generation: 0 })
    assert.deepEqual(outcome, { kind: 'nothing' })
  })

  it('成功时回传被遮蔽的条数与 token 数', async () => {
    const seen: unknown[] = []
    const outcome = await compactPeer({
      engine: engine(async agent => {
        seen.push(agent)
        return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 1234, summarySeq: 9 }
      }),
      agentAt: agentAt(handle()),
      peerId: 'u1',
      generation: 2,
    })
    assert.deepEqual(outcome, { kind: 'done', shadowed: 3, tokens: 1234 })
    assert.equal(seen.length, 1)
  })

  it('把宿主的 busy 与 cancelled 错误码翻成对应结论', async () => {
    const busy = await compactPeer({
      engine: engine(async () => { throw Object.assign(new Error('busy'), { name: 'ManualCompactionError', code: 'busy' }) }),
      agentAt: agentAt(handle()),
      peerId: 'u1',
      generation: 0,
    })
    assert.deepEqual(busy, { kind: 'busy' })

    const cancelled = await compactPeer({
      engine: engine(async () => { throw Object.assign(new Error('cancelled'), { name: 'ManualCompactionError', code: 'cancelled' }) }),
      agentAt: agentAt(handle()),
      peerId: 'u1',
      generation: 0,
    })
    assert.deepEqual(cancelled, { kind: 'cancelled' })
  })

  it('其他失败保留原因，并且不抛出', async () => {
    const reports: string[] = []
    const outcome = await compactPeer({
      engine: engine(async () => { throw new Error('summary too long') }),
      agentAt: agentAt(handle()),
      peerId: 'u1',
      generation: 0,
      report: line => { reports.push(line) },
    })
    assert.deepEqual(outcome, { kind: 'failed', message: 'summary too long' })
    assert.ok(reports.some(line => line.includes('压缩失败')))
  })

  it('取会话失败也回一句原因，而不是把异常丢出去', async () => {
    const outcome = await compactPeer({
      engine: engine(async () => null),
      agentAt: async () => { throw new Error('会话没起来') },
      peerId: 'u1',
      generation: 0,
    })
    assert.deepEqual(outcome, { kind: 'failed', message: '会话没起来' })
  })
})
