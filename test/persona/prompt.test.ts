import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePersonaCard } from '../../src/persona/card.ts'
import { buildSystemPrompt } from '../../src/persona/prompt.ts'

describe('buildSystemPrompt', () => {
  const card = (() => {
    const result = parsePersonaCard(
      {
        id: 'jarvis',
        name: '贾维斯',
        prompt: {
          identity: '你是{{name}}，{{peer}}的搭子。',
          style: ['1-2 句', '少用感叹号'],
          rules: ['不知道就说不知道'],
          forbidden: ['不复述对方原话'],
        },
        reply: { maxChars: 80 },
        examples: [{ user: '在吗', assistant: '在。说。' }],
      },
      'jarvis',
    )
    if (!result.ok) throw new Error('fixture 不合法')
    return result.card
  })()

  const context = {
    peer: '老王',
    now: new Date('2026-10-26T14:05:00+08:00'),
    timeZone: 'Asia/Shanghai',
  }

  it('段落顺序固定，且变量已插值', () => {
    const prompt = buildSystemPrompt(card, context)
    const order = ['# 身份', '# 风格', '# 规则', '# 禁止', '# 此刻', '# 表达长度', '# 示例']
    let cursor = -1
    for (const heading of order) {
      const at = prompt.indexOf(heading)
      assert.ok(at > cursor, `${heading} 应在上一段之后`)
      cursor = at
    }
    assert.match(prompt, /你是贾维斯，老王的搭子。/)
    assert.match(prompt, /现在是2026-10-26 周一 14:05。你在微信上和「老王」单聊。/)
    assert.match(prompt, /通常约 80 字/)
  })

  it('没有记忆时不渲染「你记得」', () => {
    const prompt = buildSystemPrompt(card, context)
    assert.doesNotMatch(prompt, /你记得/)
  })

  it('有记忆时渲染在「此刻」段', () => {
    const prompt = buildSystemPrompt(card, { ...context, memory: '他昨天加班到两点' })
    assert.match(prompt, /你记得：他昨天加班到两点/)
  })

  it('示例渲染成对话形式', () => {
    const prompt = buildSystemPrompt(card, context)
    assert.match(prompt, /对方：在吗\n你：在。说。/)
  })

  it('未知变量原样保留，不会被吞掉', () => {
    const withVar = parsePersonaCard({
      id: 'v',
      name: 'V',
      prompt: { identity: '你是{{name}}，代号{{codename}}。' },
    })
    assert.equal(withVar.ok, true)
    if (!withVar.ok) return
    const prompt = buildSystemPrompt(withVar.card, context)
    assert.match(prompt, /代号\{\{codename\}\}/)
  })

  it('同一输入渲染结果稳定（可缓存）', () => {
    assert.equal(buildSystemPrompt(card, context), buildSystemPrompt(card, context))
  })
})
