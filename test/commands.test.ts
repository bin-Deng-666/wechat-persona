/**
 * 内置命令：解析与文案。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  formatAgo,
  formatHelp,
  formatNewChat,
  formatPersona,
  formatStatus,
  formatUnknown,
  parseCommand,
} from '../src/channel/commands.ts'

describe('parseCommand', () => {
  it('普通消息不是命令', () => {
    assert.equal(parseCommand('在吗'), undefined)
    assert.equal(parseCommand('价格是 /bin 吗'), undefined)
  })

  it('解析命令名与参数，名字转小写', () => {
    assert.deepEqual(parseCommand('/NEW'), { name: 'new', args: [] })
    assert.deepEqual(parseCommand('  /persona   xiao-jing  '), { name: 'persona', args: ['xiao-jing'] })
  })

  it('未知命令也当命令（要回一句「没有这个命令」）', () => {
    assert.deepEqual(parseCommand('/foo bar'), { name: 'foo', args: ['bar'] })
  })

  it('只有一个斜杠视为普通消息', () => {
    assert.equal(parseCommand('/'), undefined)
  })
})

describe('文案', () => {
  it('help 列出全部命令', () => {
    const text = formatHelp()
    for (const name of ['/help', '/new', '/status', '/persona']) assert.match(text, new RegExp(name.replace('/', '\\/')))
  })

  it('未知命令提示看 help', () => {
    assert.match(formatUnknown('foo'), /没有 \/foo/)
  })

  it('new 说明旧记录仍在', () => {
    assert.match(formatNewChat(2), /第 3 段/)
    assert.match(formatNewChat(2), /还在记录里/)
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
