/**
 * 内置命令：解析与文案。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  formatAgo,
  formatCompact,
  formatHelp,
  formatNewChat,
  formatPersona,
  formatStatus,
  formatStyle,
  formatUnknown,
  parseCommand,
} from '../../src/wechat/commands.ts'

describe('parseCommand', () => {
  it('普通消息不是命令', () => {
    assert.equal(parseCommand('在吗'), undefined)
    assert.equal(parseCommand('价格是 /bin 吗'), undefined)
  })

  it('解析命令名与参数，名字转小写', () => {
    assert.deepEqual(parseCommand('/NEW'), { name: 'new', args: [] })
    assert.deepEqual(parseCommand('  /persona   jarvis  '), { name: 'persona', args: ['jarvis'] })
  })

  it('未知命令也当命令（要回一句「没有这个命令」）', () => {
    assert.deepEqual(parseCommand('/foo bar'), { name: 'foo', args: ['bar'] })
  })

  it('只有一个斜杠视为普通消息', () => {
    assert.equal(parseCommand('/'), undefined)
  })

  it('中文菜单与设置不需要斜杠', () => {
    for (const text of ['菜单', ' 设置 ', '菜单\n']) assert.deepEqual(parseCommand(text), { name: 'menu', args: [] })
    assert.deepEqual(parseCommand('新对话'), { name: 'new', args: [] })
    assert.deepEqual(parseCommand('压缩'), { name: 'compact', args: [] })
    assert.deepEqual(parseCommand('压缩对话'), { name: 'compact', args: [] })
    assert.deepEqual(parseCommand('人格 jarvis'), { name: 'persona', args: ['jarvis'] })
    assert.deepEqual(parseCommand('分条 按句'), { name: 'style', args: ['sentence'] })
    assert.deepEqual(parseCommand('表情 收 狗头'), { name: '表情', args: ['收', '狗头'] })
  })

  it('提到设置和菜单的聊天不被吞成命令', () => {
    for (const text of ['菜单怎么设计', '菜单 怎么设计', '帮我打开菜单', '设置 一下今天的计划', '表情 很有意思', '分条 帮我解释一下', '压缩 一下这个对话']) {
      assert.equal(parseCommand(text), undefined, text)
    }
  })
})

describe('文案', () => {
  it('help 列出全部命令', () => {
    const text = formatHelp()
    for (const name of ['帮助', '菜单', '新对话', '状态', '人格']) assert.ok(text.includes(name))
  })

  it('未知命令提示看 help', () => {
    assert.match(formatUnknown('foo'), /没有 \/foo/)
  })

  it('new 说明旧记录仍在', () => {
    assert.match(formatNewChat(2), /第 3 段/)
    assert.match(formatNewChat(2), /还在记录里/)
  })

  it('compact 覆盖成功、空历史、忙碌、取消、不可用与失败', () => {
    assert.match(formatCompact({ kind: 'done', shadowed: 12, tokens: 3456 }), /已压缩 12 条历史（约 3456 tokens）/)
    assert.match(formatCompact({ kind: 'nothing' }), /还没有可压缩/)
    assert.match(formatCompact({ kind: 'busy' }), /正在跑/)
    assert.match(formatCompact({ kind: 'cancelled' }), /取消/)
    assert.match(formatCompact({ kind: 'unavailable' }), /没有提供压缩能力/)
    assert.match(formatCompact({ kind: 'failed', message: '摘要过长' }), /摘要过长/)
  })

  it('status 含人格、段数、条数、权限', () => {
    const text = formatStatus({ personaId: 'default', personaName: '小助手', generation: 1, turns: 12, permission: 'danger-full-access' })
    assert.match(text, /小助手（default）/)
    assert.match(text, /第 2 段/)
    assert.match(text, /累计消息：12 条/)
    assert.match(text, /danger-full-access/)
  })

  it('persona 列出时标注当前，切换时给出确认', () => {
    const list = formatPersona('a', [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }])
    assert.match(list, /→ a 甲/)
    const switched = formatPersona('b', [], { id: 'b', name: '乙' })
    assert.match(switched, /已切到「乙」/)
  })

  it('formatAgo 分级', () => {
    assert.equal(formatAgo(30_000), '刚刚')
    assert.equal(formatAgo(5 * 60_000), '5 分钟前')
    assert.equal(formatAgo(3 * 3_600_000), '3 小时前')
    assert.equal(formatAgo(2 * 86_400_000), '2 天前')
  })
})

describe('formatStyle', () => {
  it('说明当前分条方式与来源', () => {
    const text = formatStyle({ maxChars: 120, split: 'sentence', overridden: false })
    assert.match(text, /120 字/)
    assert.match(text, /按句子切/)
    assert.match(text, /人格卡/)
  })

  it('聊天设置覆盖时点明来源', () => {
    const text = formatStyle({ maxChars: 300, split: 'none', overridden: true })
    assert.match(text, /不切/)
    assert.match(text, /这个聊天的设置/)
  })
})
