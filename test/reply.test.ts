/**
 * 回复提取与投递队列的测试。队列用注入的 sleep，不真的等。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { extractAssistantText, isThrottled, ReplyQueue } from '../src/bridge/reply.ts'

const textEvent = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }] }, ...extra },
})

describe('extractAssistantText', () => {
  it('普通回答取到文本', () => {
    assert.equal(extractAssistantText(textEvent('你好')), '你好')
  })

  it('非 assistant/message 的事件忽略', () => {
    assert.equal(extractAssistantText({ type: 'user/message' }), undefined)
    assert.equal(extractAssistantText(null), undefined)
  })

  it('带工具调用的消息是旁白，不发', () => {
    const event = {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '接下来改解析器：' }, { type: 'tool-call', name: 'edit' }] } },
    }
    assert.equal(extractAssistantText(event), undefined)
  })

  it('被中断的一轮不发半句话', () => {
    assert.equal(extractAssistantText(textEvent('说到一半', { interrupted: true })), undefined)
  })

  it('多个文本块拼接', () => {
    const event = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } } }
    assert.equal(extractAssistantText(event), 'ab')
  })

  it('空文本不发', () => {
    assert.equal(extractAssistantText(textEvent('   ')), undefined)
  })
})

describe('isThrottled', () => {
  it('识别 code -2', () => {
    assert.equal(isThrottled({ code: -2 }), true)
    assert.equal(isThrottled({ code: 1 }), false)
    assert.equal(isThrottled(new Error('x')), false)
  })
})

describe('ReplyQueue', () => {
  /** 记录发送，并按脚本失败。 */
  function sender(script: { fail?: unknown[]; throttle?: number } = {}) {
    const sent: { peerId: string; text: string; token: string | undefined }[] = []
    let throttles = script.throttle ?? 0
    const send = async (peerId: string, text: string, token: string | undefined): Promise<void> => {
      const failure = script.fail?.shift()
      if (failure !== undefined) throw failure
      if (throttles > 0) {
        throttles -= 1
        throw Object.assign(new Error('throttled'), { code: -2 })
      }
      sent.push({ peerId, text, token })
    }
    return { sent, send }
  }

  const noSleep = async (): Promise<void> => {}

  it('按顺序发出切分后的多条', async () => {
    const { sent, send } = sender()
    const queue = new ReplyQueue({ send, sleep: noSleep, plan: { softChars: 20, hardChars: 2_000, splitMode: 'paragraph', maxBubbles: 99, gapMs: 0 } })
    await queue.enqueue('p1', '第一段'.repeat(10) + '\n\n' + '第二段'.repeat(10), 'ctx')
    assert.ok(sent.length >= 2)
    assert.equal(sent[0]?.token, 'ctx')
    for (const item of sent) assert.ok(item.text.length <= 20)
  })

  it('普通失败会重试，成功后不再重试', async () => {
    const { sent, send } = sender({ fail: [new Error('boom')] })
    const queue = new ReplyQueue({ send, sleep: noSleep })
    await queue.enqueue('p1', 'hi')
    assert.equal(sent.length, 1)
    assert.equal(sent[0]?.text, 'hi')
  })

  it('连续失败到上限后放弃并回调', async () => {
    const giveUps: string[] = []
    const { send } = sender({ fail: [new Error('x'), new Error('x'), new Error('x')] })
    const queue = new ReplyQueue({ send, sleep: noSleep, maxAttempts: 3, onGiveUp: (_peer, text) => giveUps.push(text) })
    await queue.enqueue('p1', 'hi')
    assert.deepEqual(giveUps, ['hi'])
  })

  it('限流按退避重试，最终发出', async () => {
    const waits: number[] = []
    const { sent, send } = sender({ throttle: 2 })
    const queue = new ReplyQueue({
      send,
      sleep: async (ms) => { waits.push(ms) },
      maxThrottleAttempts: 5,
    })
    await queue.enqueue('p1', 'hi')
    assert.equal(sent.length, 1)
    assert.deepEqual(waits, [2_000, 4_000])
  })

  it('限流次数用尽后按普通失败处理', async () => {
    const giveUps: string[] = []
    const { send } = sender({ throttle: 99 })
    const queue = new ReplyQueue({
      send,
      sleep: noSleep,
      maxThrottleAttempts: 1,
      maxAttempts: 2,
      onGiveUp: (_peer, text) => giveUps.push(text),
    })
    await queue.enqueue('p1', 'hi')
    assert.deepEqual(giveUps, ['hi'])
  })

  it('同一 peer 的发送保序', async () => {
    const order: string[] = []
    const send = async (_peer: string, text: string): Promise<void> => {
      await new Promise(resolve => setTimeout(resolve, text === 'a' ? 10 : 1))
      order.push(text)
    }
    const queue = new ReplyQueue({ send, sleep: noSleep })
    const first = queue.enqueue('p1', 'a')
    const second = queue.enqueue('p1', 'b')
    await Promise.all([first, second])
    assert.deepEqual(order, ['a', 'b'])
  })

  it('一个 peer 失败不影响另一个', async () => {
    const sent: string[] = []
    const send = async (peerId: string, text: string): Promise<void> => {
      if (peerId === 'bad') throw new Error('unreachable')
      sent.push(text)
    }
    const queue = new ReplyQueue({ send, sleep: noSleep, maxAttempts: 1 })
    await Promise.all([queue.enqueue('bad', 'x'), queue.enqueue('good', 'y')])
    assert.deepEqual(sent, ['y'])
  })

  it('whenIdle 等到队列排空', async () => {
    const sent: string[] = []
    const queue = new ReplyQueue({ send: async (_p, text) => { await new Promise(r => setTimeout(r, 5)); sent.push(text) }, sleep: noSleep })
    void queue.enqueue('p1', 'a')
    await queue.whenIdle()
    assert.deepEqual(sent, ['a'])
    assert.equal(queue.isBusy('p1'), false)
  })
})
