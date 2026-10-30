/**
 * 回复提取与投递队列的测试。队列用注入的 sleep，不真的等。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { extractAssistantText } from '../../src/dsh/events.ts'
import { isThrottled, ReplyQueue } from '../../src/reply/queue.ts'

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
    const queue = new ReplyQueue({ send, sleep: noSleep, plan: { softChars: 20, hardChars: 2_000, splitMode: 'paragraph', gapMs: 0 } })
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


  it('限流退避期间刷新令牌，用最新入站令牌重试', async () => {
    const tokens: (string | undefined)[] = []
    let current = 'old-token', throttles = 1
    const queue = new ReplyQueue({
      send: async (_peer, _text, token) => {
        tokens.push(token)
        if (throttles > 0) { throttles -= 1; throw Object.assign(new Error('throttled'), { code: -2 }) }
      },
      // 退避期间用户又发了一条消息：令牌应换成新的。
      sleep: async () => { current = 'fresh-token' },
      maxThrottleAttempts: 3,
    })
    await queue.enqueue('p1', 'hi', () => current)
    assert.deepEqual(tokens, ['old-token', 'fresh-token'])
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


  it('相邻气泡按最小间隔节流，不额外拖慢第一条', async () => {
    const waits: number[] = []
    let clock = 0
    const queue = new ReplyQueue({
      send: async () => { clock += 100 },
      sleep: async ms => { waits.push(ms); clock += ms },
      now: () => clock,
      minIntervalMs: 2_000,
      plan: { softChars: 200, hardChars: 4_000, splitMode: 'paragraph', gapMs: 0 },
    })
    await queue.enqueue('p1', '一[分条]二[分条]三')
    assert.deepEqual(waits, [2_000, 2_000])
  })


  it('关键提示在限流下有更长的重试预算', async () => {
    let attempts = 0
    const queue = new ReplyQueue({
      send: async () => { attempts += 1; throw Object.assign(new Error('throttled'), { code: -2 }) },
      sleep: async () => {},
      maxThrottleAttempts: 2,
    })
    const normal = await queue.enqueue('p1', '普通')
    assert.equal(normal.status, 'failed')
    const normalAttempts = attempts
    attempts = 0
    const urgent = await queue.enqueue('p1', '重要', undefined, undefined, { urgent: true })
    assert.equal(urgent.status, 'failed')
    assert.ok(attempts > normalAttempts, `关键提示应多试几次：${attempts} vs ${normalAttempts}`)
  })

  it('报平安被限流时直接作废，不消耗重试次数', async () => {
    let attempts = 0
    const queue = new ReplyQueue({
      send: async () => { attempts += 1; throw Object.assign(new Error('throttled'), { code: -2 }) },
      sleep: async () => {},
      lowPriorityThrottleAttempts: 0,
    })
    const report = await queue.enqueue('p1', '报平安', undefined, undefined, { priority: 'low' })
    assert.equal(report.status, 'cancelled')
    assert.equal(attempts, 1, '只应尝试一次')
  })

  it('回答在限流下的重试预算高于普通消息', async () => {
    const attemptsOf = async (priority: 'high' | 'normal' | 'low'): Promise<number> => {
      let attempts = 0
      const queue = new ReplyQueue({
        send: async () => { attempts += 1; throw Object.assign(new Error('throttled'), { code: -2 }) },
        sleep: async () => {},
        highPriorityThrottleAttempts: 5,
        maxThrottleAttempts: 2,
        lowPriorityThrottleAttempts: 0,
      })
      await queue.enqueue('p1', 'x', undefined, undefined, { priority })
      return attempts
    }
    const high = await attemptsOf('high')
    const normal = await attemptsOf('normal')
    const low = await attemptsOf('low')
    assert.equal(high, 6, `回答应试满 5 次退避 + 1 次最终：${high}`)
    assert.equal(normal, 3, `普通消息应试满 2 次退避 + 1 次最终：${normal}`)
    assert.equal(low, 1, `报平安不应重试：${low}`)
  })

  it('回答在排队时，报平安主动让路', async () => {
    const sent: string[] = []
    const yields: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const queue = new ReplyQueue({
      send: async (_peer, text) => { await gate; sent.push(text) },
      sleep: async () => {},
      onYield: (_peer, text) => yields.push(text),
    })
    // 回答先入队并占住发送，报平安此时进来应被丢弃。
    const answer = queue.enqueue('p1', '答案', undefined, undefined, { priority: 'high' })
    await new Promise(resolve => setTimeout(resolve, 10))
    const notice = await queue.enqueue('p1', '报平安', undefined, undefined, { priority: 'low' })
    assert.equal(notice.status, 'cancelled')
    assert.deepEqual(yields, ['报平安'])
    release?.()
    await answer
    assert.deepEqual(sent, ['答案'])
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

describe('发送等待', () => {
  it('第一条回复没有额外的随机思考延迟', async () => {
    const waits: number[] = []
    const queue = new ReplyQueue({ send: async () => {}, sleep: async ms => { waits.push(ms) } })
    await queue.enqueue('p1', '普通回复')
    assert.deepEqual(waits, [])
  })
})
