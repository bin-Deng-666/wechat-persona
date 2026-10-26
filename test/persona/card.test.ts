/**
 * 人格卡解析与 prompt 组装的单元测试。
 *
 * 只测纯逻辑：没有文件系统、没有网络、没有 DSH。跑法：
 *   npm test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parsePersonaCard } from '../../src/persona/card.ts'

const minimal = {
  id: 'jarvis',
  name: '贾维斯',
  prompt: { identity: '你是{{name}}，一个住在微信里的搭子。' },
}

describe('parsePersonaCard', () => {
  it('最小卡片能通过，并补上默认值', () => {
    const result = parsePersonaCard(minimal, 'jarvis')
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.card.reply.maxChars, 120)
    assert.equal(result.card.reply.split, 'paragraph')
    assert.equal(result.card.media.sendStickers, true)
    assert.deepEqual(result.card.examples, [])
    assert.deepEqual(result.warnings, [])
  })

  it('缺少 identity 直接失败', () => {
    const result = parsePersonaCard({ id: 'a', name: 'A', prompt: {} })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.issues.some(issue => issue.path === 'prompt.identity'))
  })

  it('id 与目录名不一致直接失败', () => {
    const result = parsePersonaCard({ ...minimal, id: 'other' }, 'jarvis')
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.issues.some(issue => issue.path === 'id'))
  })

  it('id 非法字符直接失败', () => {
    const result = parsePersonaCard({ ...minimal, id: '贾维斯' })
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

  it('reply.maxChars 越界被夹住而不是报错', () => {
    const result = parsePersonaCard({ ...minimal, reply: { maxChars: 99_999 } })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.card.reply.maxChars, 4096)
    assert.ok(result.warnings.some(issue => issue.path === 'reply.maxChars'))
  })

  it('已移除的字段给出明确警告，而不是静默忽略', () => {
    const result = parsePersonaCard({
      ...minimal,
      sampling: { temperature: 0.5 },
      greeting: '来了',
      aliases: ['阿鲸'],
      media: { understandImages: false },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    for (const path of ['sampling', 'greeting', 'aliases', 'media.understandImages']) {
      assert.ok(result.warnings.some(issue => issue.path === path), `missing warning for ${path}`)
    }
    assert.equal('sampling' in result.card, false)
    assert.equal('greeting' in result.card, false)
    assert.equal('aliases' in result.card, false)
  })

  it('旧人格卡的主动搭话字段不再进入运行配置', () => {
    const result = parsePersonaCard({ ...minimal, proactive: { enabled: true, minIdleHours: 1 } })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal('proactive' in result.card, false)
    assert.ok(result.warnings.some(issue => issue.path === 'proactive' && issue.message.includes('已移除')))
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
