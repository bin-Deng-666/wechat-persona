/** 正文抽取：只有真正结束的回答才算，带工具调用的一步不算。 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extractAssistantText } from '../../src/dsh/events.ts'

const step = (content: unknown) => ({ type: 'assistant/message', data: { message: { content } } })

describe('extractAssistantText', () => {
  it('纯文本回答原样返回', () => {
    assert.equal(extractAssistantText(step([{ type: 'text', text: '好了' }])), '好了')
  })

  it('带工具调用的一步不是回答（会停在冒号上）', () => {
    assert.equal(extractAssistantText(step([{ type: 'text', text: '我先看一下：' }, { type: 'tool-call', name: 'bash' }])), undefined)
  })

  it('中断的半句话不发', () => {
    const event = { type: 'assistant/message', data: { interrupted: true, message: { content: [{ type: 'text', text: '说到一半' }] } } }
    assert.equal(extractAssistantText(event), undefined)
  })

  it('空消息与无关事件不发', () => {
    assert.equal(extractAssistantText(step([{ type: 'text', text: '   ' }])), undefined)
    assert.equal(extractAssistantText({ type: 'turn/end' }), undefined)
    assert.equal(extractAssistantText(null), undefined)
  })
})
