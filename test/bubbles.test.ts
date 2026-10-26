/**
 * 分条规划：既要「像人」，又不能让一条消息长到发不出去。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DEFAULT_REPLY_PLAN, planBubbles, resolvePlan, HARD_CHARS } from '../src/bridge/bubbles.ts'
import { parsePersonaCard } from '../src/persona/card.ts'

const plan = { ...DEFAULT_REPLY_PLAN, softChars: 40, maxBubbles: 4, gapMs: 0 }

describe('planBubbles', () => {
  it('短回答只有一条', () => {
    assert.deepEqual(planBubbles('好，这就弄。', plan), ['好，这就弄。'])
  })

  it('空回答不产生气泡', () => {
    assert.deepEqual(planBubbles('   \n\n  ', plan), [])
  })

  it('超过软上限时按段落拆开', () => {
    const text = ['一'.repeat(30), '二'.repeat(30), '三'.repeat(30)].join('\n\n')
    const bubbles = planBubbles(text, plan)
    assert.equal(bubbles.length, 3)
    for (const bubble of bubbles) assert.ok(bubble.length <= 40)
  })

  it('单段超长时在句子边界切，不把句子切成两半', () => {
    const sentence = '这是完整的一句话，不该被切开。'
    const text = sentence.repeat(5)
    const bubbles = planBubbles(text, { ...plan, softChars: 30, maxBubbles: 99 })
    assert.ok(bubbles.length > 1)
    // 每一段都以句号结尾：说明切口落在句末，而不是字数上。
    for (const bubble of bubbles.slice(0, -1)) assert.ok(bubble.endsWith('。'), `切口不在句末：${bubble}`)
  })

  it('气泡数超过上限时尾部合并，不刷屏', () => {
    const text = Array.from({ length: 8 }, (_, index) => `第${String(index)}段` + '啊'.repeat(20)).join('\n\n')
    const bubbles = planBubbles(text, plan)
    assert.equal(bubbles.length, 4)
  })

  it('合并后的尾巴也不会超过硬上限', () => {
    const text = '长'.repeat(HARD_CHARS * 2)
    const bubbles = planBubbles(text, { ...plan, softChars: 100, maxBubbles: 2 })
    for (const bubble of bubbles) assert.ok(bubble.length <= HARD_CHARS)
  })

  it('切开的代码块仍然闭合', () => {
    const code = '```js\n' + 'console.log(1)\n'.repeat(12) + '```'
    const bubbles = planBubbles(code, { ...plan, softChars: 60, maxBubbles: 99 })
    for (const bubble of bubbles) {
      const fences = bubble.split('```').length - 1
      assert.equal(fences % 2, 0, `代码块没闭合：${bubble}`)
    }
  })
})

describe('resolvePlan', () => {
  const parsed = parsePersonaCard({
    id: 'chatty',
    name: '话痨',
    prompt: { identity: '说话很短。' },
    reply: { maxChars: 60, split: 'sentence' },
  })
  if (!parsed.ok) throw new Error('fixture 无效')

  it('没有聊天设置时用人格卡', () => {
    const result = resolvePlan(parsed.card)
    assert.equal(result.softChars, 60)
    assert.equal(result.splitMode, 'sentence')
    assert.equal(result.hardChars, HARD_CHARS)
  })

  it('聊天设置覆盖人格卡', () => {
    const result = resolvePlan(parsed.card, { enabled: true, proactive: false, maxChars: 200, split: 'none' })
    assert.equal(result.softChars, 200)
    assert.equal(result.splitMode, 'none')
  })
})
