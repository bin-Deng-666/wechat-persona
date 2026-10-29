import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseChoice, renderMenu, resolveChoice, type MenuView } from '../../src/wechat/menu.ts'

const view: MenuView = {
  personaId: 'default', personaName: '小助手',
  personaChoices: [{ id: 'default', name: '小助手' }, { id: 'chatty', name: '话痨' }],
  memoryCount: 3, memoryFacts: ['沟通偏好：先给结论', '常用语言：中文', '所在时区：东八区'],
  stickerCount: 4, stickerNames: ['开心', '无语', '困了', '比心'],
  modelChoices: [
    { provider: 'deepseek-account', model: 'deepseek-flash' },
    { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
    { provider: 'workbuddy', model: 'glm-5.3' },
  ],
  modelLabel: 'workbuddy/deepseek-v4.1-flash',
}

describe('parseChoice', () => {
  it('接受数字、全角数字和句号', () => {
    for (const [text, value] of [['1', 1], [' 0 ', 0], ['２。', 2], ['　４　', 4], ['12', 12], ['023', 23]] as const) assert.equal(parseChoice(text), value)
  })
  it('普通聊天不当作编号', () => {
    for (const text of ['3 点开会', '1234', '一', '1、2', '']) assert.equal(parseChoice(text), undefined)
  })
})

describe('renderMenu', () => {
  it('主菜单一屏展示状态与五个选项', () => {
    const text = renderMenu('root', view)
    assert.match(text, /当前人格：小助手/)
    assert.match(text, /1  换人格/)
    assert.match(text, /2  换模型 · workbuddy\/deepseek-v4\.1-flash/)
    assert.match(text, /3  个人记忆 · 已记下 3 条/)
    assert.match(text, /4  表情库 · 4 张可用/)
    assert.match(text, /5  新对话/)
    assert.match(text, /6  压缩对话/)
    assert.match(text, /0 关闭/)
    assert.ok(text.split('\n').length <= 14)
    assert.doesNotMatch(text, /分条|网页|http|小程序|─|主动/)
  })
  it('人格标记当前项，隐藏内部 id', () => {
    const text = renderMenu('personas', view)
    assert.match(text, /1  小助手  ✓ 当前使用/)
    assert.match(text, /2  话痨/)
    assert.doesNotMatch(text, /chatty|default/)
    assert.match(text, /0 返回/)
  })
  it('长记忆只显示单行摘要，不丢失整页选项', () => {
    const text = renderMenu('memory', { ...view, memoryCount: 12, memoryFacts: Array(12).fill('长记忆\n'.repeat(100)) })
    assert.match(text, /已经记下 12 条/)
    assert.match(text, /还有 4 条/)
    assert.match(text, /1  清空记忆/)
    assert.ok(text.length < 1100)
    assert.doesNotMatch(text, /网页/)
  })
  it('空记忆说明中文用法，不显示清空操作', () => {
    const text = renderMenu('memory', { ...view, memoryCount: 0, memoryFacts: [] })
    assert.match(text, /记住/)
    assert.doesNotMatch(text, /清空/)
  })
  it('模型平铺 provider/model，第一项跟随默认', () => {
    const text = renderMenu('models', view)
    assert.match(text, /🤖 换模型/)
    assert.match(text, /当前：workbuddy\/deepseek-v4\.1-flash/)
    assert.match(text, /1  跟随 DSH 默认/)
    assert.match(text, /2  deepseek-account\/deepseek-flash/)
    assert.match(text, /3  workbuddy\/deepseek-v4\.1-flash  ✓/)
    assert.match(text, /4  workbuddy\/glm-5\.3/)
    assert.match(text, /第 1\/1 页/)
    assert.match(text, /8  下一页（没有下一页）/)
    assert.doesNotMatch(text, /提供方|分组/)
  })
  it('长模型列表每页七项，首页尾页导航明确', () => {
    const many = { ...view, modelChoices: Array.from({ length: 18 }, (_, i) => ({ provider: 'workbuddy', model: `m-${i}` })) }
    const first = renderMenu('models', many)
    assert.match(first, /1  跟随 DSH 默认/)
    assert.match(first, /7  workbuddy\/m-5/)
    assert.match(first, /第 1\/3 页/)
    assert.match(first, /9  上一页（没有上一页）/)
    assert.doesNotMatch(first, /m-6/)
    const middle = renderMenu('models', many, 1)
    assert.match(middle, /1  workbuddy\/m-6/)
    assert.match(middle, /7  workbuddy\/m-12/)
    assert.match(middle, /第 2\/3 页/)
    const last = renderMenu('models', many, 2)
    assert.match(last, /1  workbuddy\/m-13/)
    assert.match(last, /5  workbuddy\/m-17/)
    assert.match(last, /8  下一页（没有下一页）/)
    assert.doesNotMatch(last, /m-12/)
  })
  it('人格列表超过九项时按七项分页', () => {
    const many = { ...view, personaChoices: Array.from({ length: 12 }, (_, i) => ({ id: `p-${i}`, name: `人格 ${i}` })) }
    const first = renderMenu('personas', many)
    assert.match(first, /7  人格 6/)
    assert.match(first, /第 1\/2 页/)
    assert.doesNotMatch(first, /人格 7/)
    const second = renderMenu('personas', many, 1)
    assert.match(second, /1  人格 7/)
    assert.match(second, /5  人格 11/)
    assert.match(second, /第 2\/2 页/)
  })
  it('没有模型目录时说明原因，不出现空列表', () => {
    const text = renderMenu('models', { ...view, modelChoices: [], modelLabel: '跟随 DSH 默认' })
    assert.match(text, /还没有可用的模型/)
    assert.match(text, /当前：跟随 DSH 默认/)
  })
  it('表情说明收藏和发送方法', () => {
    const text = renderMenu('stickers', view)
    assert.match(text, /开心/)
    assert.match(text, /表情 发 名字/)
    assert.match(text, /表情 收 名字/)
  })
})

describe('resolveChoice', () => {
  it('主菜单关闭，子菜单逐级返回', () => {
    assert.deepEqual(resolveChoice('root', 0), { kind: 'close' })
    for (const panel of ['personas', 'memory', 'stickers', 'models'] as const) assert.deepEqual(resolveChoice(panel, 0), { kind: 'panel', panel: 'root' })
    assert.deepEqual(resolveChoice('clear-memory', 0), { kind: 'panel', panel: 'memory' })
  })
  it('清空记忆先进入确认页', () => {
    assert.deepEqual(resolveChoice('memory', 1), { kind: 'panel', panel: 'clear-memory' })
    assert.deepEqual(resolveChoice('clear-memory', 1), { kind: 'action', action: 'clear-memory' })
  })
  it('主菜单可打开四个面板或执行新对话、压缩', () => {
    for (const [choice, panel] of [[1, 'personas'], [2, 'models'], [3, 'memory'], [4, 'stickers']] as const) assert.deepEqual(resolveChoice('root', choice), { kind: 'panel', panel })
    assert.deepEqual(resolveChoice('root', 5), { kind: 'action', action: 'new-chat' })
    assert.deepEqual(resolveChoice('root', 6), { kind: 'action', action: 'compact' })
    assert.deepEqual(resolveChoice('root', 7), { kind: 'unknown' })
  })
  it('模型页编号避开 8/9，并把跟随默认与实际模型分开', () => {
    assert.deepEqual(resolveChoice('models', 1, 0, 19), { kind: 'action', action: 'model-default' })
    assert.deepEqual(resolveChoice('models', 2, 0, 19), { kind: 'action', action: 'model-0' })
    assert.deepEqual(resolveChoice('models', 8, 0, 19), { kind: 'page', page: 1 })
    assert.deepEqual(resolveChoice('models', 9, 0, 19), { kind: 'unknown' })
    assert.deepEqual(resolveChoice('models', 1, 1, 19), { kind: 'action', action: 'model-6' })
    assert.deepEqual(resolveChoice('models', 9, 1, 19), { kind: 'page', page: 0 })
    assert.deepEqual(resolveChoice('models', 5, 2, 19), { kind: 'action', action: 'model-17' })
    assert.deepEqual(resolveChoice('models', 6, 2, 19), { kind: 'unknown' })
  })
  it('人格页把页内编号换算成全局下标', () => {
    assert.deepEqual(resolveChoice('personas', 7, 0, 12), { kind: 'action', action: 'persona-7' })
    assert.deepEqual(resolveChoice('personas', 1, 1, 12), { kind: 'action', action: 'persona-8' })
    assert.deepEqual(resolveChoice('personas', 8, 1, 12), { kind: 'unknown' })
    assert.deepEqual(resolveChoice('personas', 9, 1, 12), { kind: 'page', page: 0 })
  })
})
