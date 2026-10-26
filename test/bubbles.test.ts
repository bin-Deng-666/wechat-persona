/**
 * 分条规划：既要「像人」，又不能让一条消息长到发不出去。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DEFAULT_REPLY_PLAN, planBubbles, resolvePlan, HARD_CHARS } from '../src/bridge/bubbles.ts'
import { parsePersonaCard } from '../src/persona/card.ts'

const plan = { ...DEFAULT_REPLY_PLAN, softChars: 40, gapMs: 0 }

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
    const bubbles = planBubbles(text, { ...plan, softChars: 30 })
    assert.ok(bubbles.length > 1)
    // 每一段都以句号结尾：说明切口落在句末，而不是字数上。
    for (const bubble of bubbles.slice(0, -1)) assert.ok(bubble.endsWith('。'), `切口不在句末：${bubble}`)
  })

  it('长文按段落数出条数，不合并、不超限', () => {
    const text = Array.from({ length: 8 }, (_, index) => `第${String(index)}段` + '啊'.repeat(20)).join('\n\n')
    const bubbles = planBubbles(text, plan)
    assert.equal(bubbles.length, 8)
    for (const bubble of bubbles) assert.ok(bubble.length <= 40)
  })

  it('单条永远不会超过软上限', () => {
    const text = '长'.repeat(HARD_CHARS * 2)
    const bubbles = planBubbles(text, { ...plan, softChars: 100 })
    for (const bubble of bubbles) assert.ok(bubble.length <= 100)
  })

  it('切开的代码块仍然闭合', () => {
    const code = '```js\n' + 'console.log(1)\n'.repeat(12) + '```'
    const bubbles = planBubbles(code, { ...plan, softChars: 60 })
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

  it('按句切的人格才用卡片里的短句长', () => {
    const result = resolvePlan(parsed.card)
    assert.equal(result.softChars, 60)
    assert.equal(result.splitMode, 'sentence')
    assert.equal(result.hardChars, HARD_CHARS)
  })

  it('普通人格不拿卡片字数当气泡大小（默认一条发完）', () => {
    const plain = parsePersonaCard({
      id: 'plain',
      name: '普通',
      prompt: { identity: '说话简短。' },
      reply: { maxChars: 120, split: 'paragraph' },
    })
    if (!plain.ok) throw new Error('fixture 无效')
    const result = resolvePlan(plain.card)
    assert.equal(result.softChars, 600)
  })

  it('聊天设置覆盖人格卡', () => {
    const result = resolvePlan(parsed.card, { enabled: true, proactive: false, maxChars: 200, split: 'none' })
    assert.equal(result.softChars, 200)
    assert.equal(result.splitMode, 'none')
  })
})
