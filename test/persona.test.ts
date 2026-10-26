/**
 * 人格卡解析与 prompt 组装的单元测试。
 *
 * 只测纯逻辑：没有文件系统、没有网络、没有 DSH。跑法：
 *   node --test --experimental-strip-types test/*.test.ts
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parsePersonaCard } from '../src/persona/card.ts'
import { buildSystemPrompt } from '../src/persona/prompt.ts'

const minimal = {
  id: 'xiao-jing',
  name: '小鲸',
  prompt: { identity: '你是{{name}}，一个住在微信里的搭子。' },
}

describe('parsePersonaCard', () => {
  it('最小卡片能通过，并补上默认值', () => {
    const result = parsePersonaCard(minimal, 'xiao-jing')
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.card.sampling.temperature, 0.7)
    assert.equal(result.card.sampling.maxTokens, 800)
    assert.equal(result.card.reply.maxChars, 120)
    assert.equal(result.card.reply.split, 'paragraph')
    assert.deepEqual(result.card.aliases, [])
    assert.deepEqual(result.card.examples, [])
    assert.equal(result.card.media.understandImages, true)
    assert.deepEqual(result.warnings, [])
  })

  it('缺少 identity 直接失败', () => {
    const result = parsePersonaCard({ id: 'a', name: 'A', prompt: {} })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.issues.some(issue => issue.path === 'prompt.identity'))
  })

  it('id 与目录名不一致直接失败', () => {
    const result = parsePersonaCard({ ...minimal, id: 'other' }, 'xiao-jing')
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.issues.some(issue => issue.path === 'id'))
  })

  it('id 非法字符直接失败', () => {
    const result = parsePersonaCard({ ...minimal, id: '小鲸' })
    assert.equal(result.ok, false)
  })

  it('风格超长截断并给出警告', () => {
    const long = '啊'.repeat(80)
    const result = parsePersonaCard({
      ...minimal,
      prompt: { identity: '你是{{name}}', style: [long] },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.card.prompt.style[0]?.length, 60)
    assert.ok(result.warnings.some(issue => issue.path === 'prompt.style'))
  })

  it('风格条目超过 8 条只保留前 8 条', () => {
    const style = Array.from({ length: 10 }, (_, index) => `风格${String(index)}`)
    const result = parsePersonaCard({ ...minimal, prompt: { identity: '你是{{name}}', style } })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.card.prompt.style.length, 8)
  })

  it('温度越界被夹住而不是报错', () => {
    const result = parsePersonaCard({ ...minimal, sampling: { temperature: 9 } })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.card.sampling.temperature, 2)
    assert.ok(result.warnings.some(issue => issue.path === 'sampling.temperature'))
  })

  it('安静时段格式错误回落默认值', () => {
    const result = parsePersonaCard({ ...minimal, proactive: { quietHours: ['9:00', '25:00'] } })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.card.proactive.quietHours, ['23:00', '08:00'])
  })

  it('示例最多保留 5 组，条目缺字段的丢掉', () => {
    const examples = [
      ...Array.from({ length: 7 }, (_, index) => ({ user: `u${String(index)}`, assistant: `a${String(index)}` })),
      { user: '缺 assistant' },
    ]
    const result = parsePersonaCard({ ...minimal, examples })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.card.examples.length, 5)
    assert.ok(result.warnings.some(issue => issue.path === 'examples'))
  })
})

describe('buildSystemPrompt', () => {
  const card = (() => {
    const result = parsePersonaCard(
      {
        id: 'xiao-jing',
        name: '小鲸',
        prompt: {
          identity: '你是{{name}}，{{peer}}的搭子。',
          style: ['1-2 句', '少用感叹号'],
          rules: ['不知道就说不知道'],
          forbidden: ['不复述对方原话'],
        },
        reply: { maxChars: 80 },
        examples: [{ user: '在吗', assistant: '在。说。' }],
      },
      'xiao-jing',
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
    const order = ['# 身份', '# 风格', '# 规则', '# 禁止', '# 此刻', '# 长度', '# 示例']
    let cursor = -1
    for (const heading of order) {
      const at = prompt.indexOf(heading)
      assert.ok(at > cursor, `${heading} 应在上一段之后`)
      cursor = at
    }
    assert.match(prompt, /你是小鲸，老王的搭子。/)
    assert.match(prompt, /现在是周一 14:05。你在微信上和「老王」单聊。/)
    assert.match(prompt, /一般不超过 80 字/)
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
