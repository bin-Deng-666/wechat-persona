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

describe('progress 字段（干活时的报平安短句）', () => {
  const base = { ...minimal }
  /** 凑够下限的填充句；测试只关心首尾几条。 */
  const fill = (count: number) => Array.from({ length: count }, (_, index) => `填充${String(index)}。`)

  it('合法数组原样保留', () => {
    const progress = ['在弄，别急。', ...fill(8), '快好了。']
    const result = parsePersonaCard({ ...base, progress })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.card.progress, progress)
  })

  it('非数组给出警告并回退到内置库（空数组）', () => {
    const result = parsePersonaCard({ ...base, progress: '在弄，别急。' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.card.progress, [])
    assert.ok(result.warnings.some(issue => issue.path === 'progress' && issue.message.includes('字符串数组')))
  })

  it('空串与纯空白被过滤，并计数', () => {
    const result = parsePersonaCard({ ...base, progress: ['在弄。', ...fill(9), '', '   '] })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.card.progress.length, 10)
    assert.equal(result.card.progress[0], '在弄。')
    assert.ok(result.warnings.some(issue => issue.path === 'progress' && issue.message.includes('2 条空串')))
  })

  it('非字符串条目被过滤', () => {
    const result = parsePersonaCard({ ...base, progress: ['在弄。', ...fill(9), 42, null, { a: 1 }] })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.card.progress.length, 10)
    assert.ok(result.warnings.some(issue => issue.path === 'progress' && issue.message.includes('3 条空串或非字符串')))
  })

  it('重复条目合并，归一化空白后判重', () => {
    const result = parsePersonaCard({ ...base, progress: ['在弄。', ...fill(9), '在弄。', ' 在弄。 '] })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.card.progress.length, 10)
    assert.equal(result.card.progress.filter(line => line === '在弄。').length, 1)
    assert.ok(result.warnings.some(issue => issue.path === 'progress' && issue.message.includes('2 条重复')))
  })

  it('超过 20 字的条目被截断并加省略号', () => {
    const long = '这是一条特别特别长的报平安句子用来测试截断逻辑'
    const result = parsePersonaCard({ ...base, progress: [long, ...fill(9)] })
    assert.equal(result.ok, true)
    if (!result.ok) return
    const first = result.card.progress[0] ?? ''
    assert.ok(first.endsWith('…'), first)
    assert.equal(Array.from(first).length, 20)
    assert.ok(result.warnings.some(issue => issue.path === 'progress' && issue.message.includes('已截断')))
  })

  it('超过 40 条只保留前 40 条', () => {
    const many = Array.from({ length: 45 }, (_, index) => `第${String(index)}句。`)
    const result = parsePersonaCard({ ...base, progress: many })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.card.progress.length, 40)
    assert.ok(result.warnings.some(issue => issue.path === 'progress' && issue.message.includes('只保留前 40 条')))
  })

  it('不足 10 条时回退内置库并提示', () => {
    const result = parsePersonaCard({ ...base, progress: ['在弄。', '快好了。'] })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.card.progress, [])
    assert.ok(result.warnings.some(issue => issue.path === 'progress' && issue.message.includes('建议至少 10 条')))
  })

  it('刚好 10 条就能用——30 秒一句、5 分钟窗口正好不重复', () => {
    const progress = fill(10)
    const result = parsePersonaCard({ ...base, progress })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.card.progress, progress)
    assert.equal(result.warnings.some(issue => issue.path === 'progress'), false)
  })

  it('完全不写这个字段时为空数组，由插件回退内置库', () => {
    const result = parsePersonaCard({ ...base })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.card.progress, [])
    assert.equal(result.warnings.some(issue => issue.path === 'progress'), false)
  })
})
