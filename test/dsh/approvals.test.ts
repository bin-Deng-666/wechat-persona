/**
 * 微信里的审批：只认明确答复，含糊的话不能被当成放行。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ApprovalBridge, formatApprovalAsk, parseApprovalAnswer } from '../../src/dsh/approvals.ts'

describe('parseApprovalAnswer', () => {
  it('明确允许', () => {
    for (const text of ['1', 'y', 'YES', '允许', '同意', '可以', 'ok']) {
      assert.equal(parseApprovalAnswer(text), 'allow', text)
    }
  })

  it('明确拒绝', () => {
    for (const text of ['2', 'n', 'no', '拒绝', '不行']) {
      assert.equal(parseApprovalAnswer(text), 'deny', text)
    }
  })

  it('取消', () => {
    for (const text of ['3', 'cancel', '取消', '算了']) {
      assert.equal(parseApprovalAnswer(text), 'cancel', text)
    }
  })

  it('全角数字也算明确答复', () => {
    assert.equal(parseApprovalAnswer('１'), 'allow')
    assert.equal(parseApprovalAnswer('２'), 'deny')
  })

  it('含糊的话不算答复', () => {
    for (const text of ['', '   ', '嗯', '让我想想', '12', '好']) {
      assert.equal(parseApprovalAnswer(text), undefined, text)
    }
  })
})

describe('formatApprovalAsk', () => {
  it('包含工具名、理由和三个选项', () => {
    const text = formatApprovalAsk({ peerId: 'p', toolName: 'bash', reason: '要删掉 3 个临时文件' })
    assert.match(text, /bash/)
    assert.match(text, /要删掉 3 个临时文件/)
    assert.match(text, /回复 1 允许/)
  })

  it('理由过长会截断，不把整段命令贴给用户', () => {
    const text = formatApprovalAsk({ peerId: 'p', toolName: 'bash', reason: 'x'.repeat(800) })
    assert.ok(text.length < 800)
  })

  it('没有理由时不留空行', () => {
    const text = formatApprovalAsk({ peerId: 'p', toolName: 'write' })
    assert.doesNotMatch(text, /原因：/)
  })
})

describe('ApprovalBridge', () => {
  function bridge(options: { timeoutMs?: number } = {}) {
    const asked: { peerId: string; text: string }[] = []
    const instance = new ApprovalBridge({
      ask: (peerId, text) => { asked.push({ peerId, text }) },
      timeoutMs: options.timeoutMs ?? 10_000,
      report: () => {},
    })
    return { instance, asked }
  }

  it('回 1 得到允许', async () => {
    const { instance, asked } = bridge()
    const pending = instance.request({ peerId: 'p', toolName: 'bash' })
    assert.equal(asked.length, 1)
    assert.equal(instance.hasPending('p'), true)
    assert.equal(instance.answer('p', '1'), true)
    assert.equal(await pending, 'allow')
    assert.equal(instance.hasPending('p'), false)
  })

  it('回 2 得到拒绝', async () => {
    const { instance } = bridge()
    const pending = instance.request({ peerId: 'p', toolName: 'bash' })
    instance.answer('p', '2')
    assert.equal(await pending, 'deny')
  })

  it('没有待决审批时，普通消息不被消费', () => {
    const { instance } = bridge()
    assert.equal(instance.answer('p', '1'), false)
  })

  it('含糊的回复继续等，不消费消息', async () => {
    const { instance } = bridge()
    const pending = instance.request({ peerId: 'p', toolName: 'bash' })
    assert.equal(instance.answer('p', '嗯让我想想'), false)
    assert.equal(instance.hasPending('p'), true)
    instance.answer('p', '1')
    assert.equal(await pending, 'allow')
  })

  it('超时判成取消', async () => {
    const { instance } = bridge({ timeoutMs: 10 })
    const answer = await instance.request({ peerId: 'p', toolName: 'bash' })
    assert.equal(answer, 'cancel')
    assert.equal(instance.hasPending('p'), false)
  })

  it('同一 peer 上后到的审批把先到的顶成取消', async () => {
    const { instance } = bridge()
    const first = instance.request({ peerId: 'p', toolName: 'bash' })
    const second = instance.request({ peerId: 'p', toolName: 'write' })
    assert.equal(await first, 'cancel')
    instance.answer('p', '1')
    assert.equal(await second, 'allow')
  })

  it('一轮结束时取消待决审批', async () => {
    const { instance } = bridge()
    const pending = instance.request({ peerId: 'p', toolName: 'bash' })
    instance.cancel('p')
    assert.equal(await pending, 'cancel')
  })

  it('提示发送失败时立即取消，不让主循环空等', async () => {
    const instance = new ApprovalBridge({ ask: () => { throw new Error('网络断了') }, report: () => {} })
    assert.equal(await instance.request({ peerId: 'p', toolName: 'bash' }), 'cancel')
  })
})
