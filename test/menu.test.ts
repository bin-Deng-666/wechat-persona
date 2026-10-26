/**
 * 设置卡片：数字只是一次点击，别把正常聊天吞掉。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseChoice, renderMenu, resolveChoice, type MenuView } from '../src/channel/menu.ts'

const view: MenuView = {
  personaId: 'default',
  personaName: '小助手',
  personaChoices: [{ id: 'default', name: '小助手' }, { id: 'chatty', name: '话痨' }],
  model: 'deepseek-flash',
  memoryCount: 3,
  memoryFacts: ['用户叫阿彬', '做前端', '住杭州'],
  proactive: false,
  maxChars: 120,
  split: 'paragraph',
  overridden: false,
  canSwitchModel: false,
  stickerCount: 0,
}

describe('parseChoice', () => {
  it('单个数字', () => {
    assert.equal(parseChoice('1'), 1)
    assert.equal(parseChoice(' 3 '), 3)
    assert.equal(parseChoice('0'), 0)
  })

  it('数字加句号也算', () => {
    assert.equal(parseChoice('2。'), 2)
  })

  it('带内容的数字不是点击', () => {
    assert.equal(parseChoice('3 点开会'), undefined)
    assert.equal(parseChoice('12'), undefined)
    assert.equal(parseChoice('一'), undefined)
  })
})

describe('renderMenu', () => {
  it('根卡片列出六项与当前状态', () => {
    const text = renderMenu('root', view)
    assert.match(text, /1 {2}人格 · 小助手/)
    assert.match(text, /3 {2}记忆 · 3 条/)
    assert.match(text, /4 {2}主动 · 关/)
    assert.match(text, /5 {2}分条 · 120 字 \/ 按段落/)
  })

  it('有表情库时多一行', () => {
    const text = renderMenu('root', { ...view, stickerCount: 4 })
    assert.match(text, /7 {2}表情库 · 4 张/)
  })

  it('人格列表标出当前项', () => {
    const text = renderMenu('personas', view)
    assert.match(text, /1 {2}小助手（default） ✓/)
    assert.match(text, /2 {2}话痨（chatty）/)
    assert.match(text, /0 {2}返回/)
  })

  it('记忆面板只展示前几条', () => {
    const text = renderMenu('memory', { ...view, memoryCount: 12 })
    assert.match(text, /用户叫阿彬/)
    assert.match(text, /还有 4 条/)
  })

  it('记忆为空时给一句怎么记', () => {
    const text = renderMenu('memory', { ...view, memoryCount: 0, memoryFacts: [] })
    assert.match(text, /记住/)
  })

  it('不支持换模型时说清楚', () => {
    const text = renderMenu('model', view)
    assert.match(text, /deepseek-flash/)
    assert.match(text, /不支持/)
  })
})

describe('resolveChoice', () => {
  it('0 关闭', () => {
    assert.deepEqual(resolveChoice('root', 0), { kind: 'close' })
  })

  it('根卡片进子面板', () => {
    assert.deepEqual(resolveChoice('root', 1), { kind: 'panel', panel: 'personas' })
    assert.deepEqual(resolveChoice('root', 5), { kind: 'panel', panel: 'style' })
  })

  it('根卡片直接执行', () => {
    assert.deepEqual(resolveChoice('root', 4), { kind: 'action', action: 'toggle-proactive' })
    assert.deepEqual(resolveChoice('root', 6), { kind: 'action', action: 'new-chat' })
  })

  it('人格按序号选', () => {
    assert.deepEqual(resolveChoice('personas', 2), { kind: 'action', action: 'persona-2' })
  })

  it('越界选项不执行', () => {
    assert.deepEqual(resolveChoice('root', 9), { kind: 'unknown' })
    assert.deepEqual(resolveChoice('memory', 5), { kind: 'unknown' })
  })
})
