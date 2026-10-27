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
  it('模型平铺 provider/model，不先选提供方', () => {
    const text = renderMenu('models', view)
    assert.match(text, /🤖 换模型/)
    assert.match(text, /当前：workbuddy\/deepseek-v4\.1-flash/)
    assert.match(text, /1  deepseek-account\/deepseek-flash/)
    assert.match(text, /2  workbuddy\/deepseek-v4\.1-flash  ✓/)
    assert.match(text, /3  workbuddy\/glm-5\.3/)
    assert.doesNotMatch(text, /提供方|分组/)
  })
  it('模型再多也一页列完，编号连续到两位数', () => {
    const many = { ...view, modelChoices: Array.from({ length: 23 }, (_, i) => ({ provider: 'workbuddy', model: `m-${i}` })) }
    const text = renderMenu('models', many)
    assert.match(text, /01  workbuddy\/m-0/)
    assert.match(text, /09  workbuddy\/m-8/)
    assert.match(text, /10  workbuddy\/m-9/)
    assert.match(text, /23  workbuddy\/m-22/)
    assert.doesNotMatch(text, /下一页|第 2 页/)
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
  it('模型页把编号换成目录下标，两位数同样有效', () => {
    assert.deepEqual(resolveChoice('models', 1), { kind: 'action', action: 'model-0' })
    assert.deepEqual(resolveChoice('models', 9), { kind: 'action', action: 'model-8' })
    assert.deepEqual(resolveChoice('models', 23), { kind: 'action', action: 'model-22' })
  })
})
