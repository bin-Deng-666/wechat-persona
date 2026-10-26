/**
 * 人格注入的测试：第一轮给完整设定，之后只给一行提醒。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { composeInboundText, PERSONA_BEGIN, PERSONA_END, reminderOf } from '../src/bridge/prompt.ts'
import { parsePersonaCard } from '../src/persona/card.ts'

const card = (() => {
  const result = parsePersonaCard(
    {
      id: 'xiao-jing',
      name: '小鲸',
      prompt: {
        identity: '你是{{name}}，{{peer}}的搭子。',
        style: ['一般 1-2 句', '少用感叹号', '第三条不该出现在提醒里'],
        rules: ['不知道就说不知道'],
      },
    },
    'xiao-jing',
  )
  if (!result.ok) throw new Error('fixture 不合法')
  return result.card
})()

describe('composeInboundText', () => {
  it('第一轮注入完整设定块', () => {
    const text = composeInboundText({
      card,
      peer: '老王',
      now: new Date('2026-10-26T14:05:00+08:00'),
      timeZone: 'Asia/Shanghai',
      text: '在吗',
      first: true,
    })
    assert.ok(text.startsWith(PERSONA_BEGIN))
    assert.ok(text.includes(PERSONA_END))
    assert.match(text, /你是小鲸，老王的搭子。/)
    assert.match(text, /# 风格/)
    assert.ok(text.endsWith('在吗'))
  })

  it('后续轮次只带一行提醒（含名字与前两条风格）', () => {
    const text = composeInboundText({ card, text: '在吗', first: false })
    assert.equal(text, `${reminderOf(card)}\n\n在吗`)
    assert.match(text, /小鲸/)
    assert.match(text, /一般 1-2 句/)
    assert.doesNotMatch(text, /第三条不该出现在提醒里/)
    assert.doesNotMatch(text, /# 身份/)
  })

  it('空文本用占位符，不投递空气泡', () => {
    const withImage = composeInboundText({ card, text: '   ', first: false })
    assert.match(withImage, /没有文字的消息/)
  })

  it('记忆注入到第一轮的「此刻」段', () => {
    const text = composeInboundText({ card, text: '早', first: true, memory: '他昨天加班到两点' })
    assert.match(text, /你记得：他昨天加班到两点/)
  })
})
