/**
 * 输入状态上报的测试：ticket 缓存、失败静默、过期重取。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { TypingIndicator } from '../src/channel/typing.ts'

function fakeApi(options: { ticket?: string; failConfig?: boolean; failTyping?: boolean } = {}) {
  const calls: { op: string; userId?: string; status?: number }[] = []
  let configCalls = 0
  const api = {
    getConfig: async () => {
      configCalls += 1
      if (options.failConfig === true) throw new Error('boom')
      return options.ticket ?? 'ticket-1'
    },
    sendTyping: async (params: { userId: string; status: number }) => {
      calls.push({ op: 'typing', userId: params.userId, status: params.status })
      if (options.failTyping === true) throw new Error('rejected')
    },
  }
  return { api, calls, configCalls: () => configCalls }
}

const base = { baseUrl: 'https://x.cn', token: 't' }

describe('TypingIndicator', () => {
  it('第一次取 ticket 后缓存复用', async () => {
    const fake = fakeApi()
    const typing = new TypingIndicator({ api: fake.api as never, ...base })
    await typing.start('u1')
    await typing.start('u1')
    assert.equal(fake.configCalls(), 1)
    assert.deepEqual(fake.calls.map(call => call.status), [1, 1])
  })

  it('stop 上报 status=2', async () => {
    const fake = fakeApi()
    const typing = new TypingIndicator({ api: fake.api as never, ...base })
    await typing.start('u1')
    await typing.stop('u1')
    assert.deepEqual(fake.calls.map(call => call.status), [1, 2])
  })

  it('没有 ticket 时 stop 什么也不做', async () => {
    const fake = fakeApi()
    const typing = new TypingIndicator({ api: fake.api as never, ...base })
    await typing.stop('u1')
    assert.deepEqual(fake.calls, [])
  })

  it('取 ticket 失败时静默跳过', async () => {
    const fake = fakeApi({ failConfig: true })
    const typing = new TypingIndicator({ api: fake.api as never, ...base })
    assert.equal(await typing.start('u1'), false)
    assert.deepEqual(fake.calls, [])
  })

  it('服务端拒绝 ticket 时丢掉缓存，下次重取', async () => {
    const fake = fakeApi({ failTyping: true })
    const typing = new TypingIndicator({ api: fake.api as never, ...base })
    await typing.start('u1')
    await typing.stop('u1')
    // 缓存被清掉：再 start 会重新取 ticket。
    await typing.start('u1')
    assert.equal(fake.configCalls(), 2)
  })
})
