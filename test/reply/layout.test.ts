/** 分条由模型按需决定，文字和表情共用同一有序队列。 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { planBubbles, DEFAULT_REPLY_PLAN, HARD_CHARS } from '../../src/reply/bubbles.ts'
import { ReplyQueue } from '../../src/reply/queue.ts'

describe('自然回复的发送边界', () => {
  it('普通短回复和自然段默认仍是一条，显式分条才变成多条', () => {
    assert.deepEqual(planBubbles('在。说。'), ['在。说。'])
    assert.deepEqual(planBubbles('第一段\n\n第二段'), ['第一段\n\n第二段'])
    assert.deepEqual(planBubbles('在。[分条]怎么了？'), ['在。', '怎么了？'])
    assert.deepEqual(planBubbles('[分条] 在。 [分条][分条]'), ['在。'])
  })
  it('素材 ID 不会被字数上限切断，none 仍遵守传输上限', () => {
    const id = 's_1234567890abcdef1234'
    const chunks = planBubbles(`好[表情:${id}]`, { ...DEFAULT_REPLY_PLAN, softChars: 1 })
    assert.equal(chunks.length, 1)
    assert.ok(chunks[0]!.includes(id))
    const long = planBubbles('长'.repeat(HARD_CHARS + 1), { ...DEFAULT_REPLY_PLAN, splitMode: 'none' })
    assert.equal(long.length, 2)
    assert.ok(long.every(text => text.length <= HARD_CHARS))
  })
  it('同一轮和后一轮的文字不会超越正在发送的表情', async () => {
    const sent: string[] = []
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const queue = new ReplyQueue({ send: async (_peer, text) => { sent.push(text) },
      sendSticker: async (_peer, name, token) => { assert.equal(token, 't1'); await blocked; sent.push('图片:' + name); return true },
      sleep: async () => {},
    })
    const first = queue.enqueue('u1', '好啊[分条][表情:开心]一起笑', 't1')
    const second = queue.enqueue('u1', '下一轮', 't2')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(sent, ['好啊'])
    release()
    await Promise.all([first, second, queue.whenIdle()])
    assert.deepEqual(sent, ['好啊', '图片:开心', '一起笑', '下一轮'])
  })
  it('表情网络失败可重试，最终失败仍保留文字且不泄露控制标记', async () => {
    let attempts = 0
    const sent: string[] = []
    const queue = new ReplyQueue({ send: async (_peer, text) => { sent.push(text) },
      sendSticker: async () => { attempts += 1; throw new Error('network') }, sleep: async () => {},
    })
    await queue.enqueue('u1', '好啊[表情:开心][分条]继续聊')
    assert.equal(attempts, 3)
    assert.deepEqual(sent, ['好啊', '继续聊'])
  })
})

describe('一个气泡里的多张表情', () => {
  it('全部保留，不被只取第一张吃掉', () => {
    const chunks = planBubbles('好[表情:a][表情:b]', { ...DEFAULT_REPLY_PLAN, softChars: 1 })
    assert.equal(chunks.length, 1)
    assert.ok(chunks[0]!.includes('[表情:a]'))
    assert.ok(chunks[0]!.includes('[表情:b]'))
  })
})
