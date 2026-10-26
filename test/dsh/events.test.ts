/** 从带工具调用的一步里读出「正在干什么」。 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extractAssistantText, extractToolActivity } from '../../src/dsh/events.ts'

const step = (content: unknown) => ({ type: 'assistant/message', data: { message: { content } } })

describe('extractToolActivity', () => {
  it('读出旁白与工具名', () => {
    assert.deepEqual(
      extractToolActivity(step([{ type: 'text', text: '我先看一下日志' }, { type: 'tool-call', name: 'bash' }])),
      { narration: '我先看一下日志', toolName: 'bash' },
    )
  })

  it('没有旁白时只给工具名', () => {
    assert.deepEqual(extractToolActivity(step([{ type: 'tool-call', name: 'grep' }])), { toolName: 'grep' })
  })

  it('旁白被拼接后去掉首尾空白', () => {
    assert.deepEqual(
      extractToolActivity(step([{ type: 'text', text: ' 正在 ' }, { type: 'text', text: '跑测试 ' }, { type: 'tool-call', name: 'bash' }])),
      { narration: '正在 跑测试', toolName: 'bash' },
    )
  })

  it('普通回答、没有工具的一步不算活动', () => {
    assert.equal(extractToolActivity(step([{ type: 'text', text: '好了' }])), undefined)
    assert.equal(extractToolActivity({ type: 'turn/end' }), undefined)
    assert.equal(extractToolActivity(null), undefined)
  })

  it('与 extractAssistantText 的分工：带工具的一步不进正文，但记活动', () => {
    const event = step([{ type: 'text', text: '我先看一下：' }, { type: 'tool-call', name: 'bash' }])
    assert.equal(extractAssistantText(event), undefined)
    assert.ok(extractToolActivity(event))
  })
})
