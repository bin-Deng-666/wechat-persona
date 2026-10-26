/**
 * 准入名单与长文切分的测试。都是纯逻辑。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createAccessPolicy, parseAllowList } from '../src/bridge/access.ts'
import { splitText } from '../src/bridge/text.ts'

describe('parseAllowList', () => {
  it('按换行/逗号/分号切分并去重', () => {
    assert.deepEqual(parseAllowList('a\nb, c；a;  b'), ['a', 'b', 'c'])
  })

  it('空输入得到空数组', () => {
    assert.deepEqual(parseAllowList(undefined), [])
    assert.deepEqual(parseAllowList('  \n '), [])
  })
})

describe('createAccessPolicy', () => {
  it('留空时只放行 owner', () => {
    const policy = createAccessPolicy({ owner: 'wxid-owner' })
    assert.equal(policy.admits('wxid-owner'), true)
    assert.equal(policy.admits('wxid-stranger'), false)
    assert.equal(policy.admitsAnyone(), true)
  })

  it('名单非空时以名单为准，owner 不再自动包含', () => {
    const policy = createAccessPolicy({ allow: 'a\nb', owner: 'wxid-owner' })
    assert.equal(policy.admits('a'), true)
    assert.equal(policy.admits('wxid-owner'), false)
    assert.deepEqual(policy.effective(), ['a', 'b'])
  })

  it('既没名单也没 owner 时谁都进不来', () => {
    const policy = createAccessPolicy({})
    assert.equal(policy.admitsAnyone(), false)
    assert.equal(policy.admits('anyone'), false)
  })

  it('空白字符串不算一个 id', () => {
    const policy = createAccessPolicy({ allow: '  ', owner: undefined })
    assert.equal(policy.admitsAnyone(), false)
  })
})

describe('splitText', () => {
  it('短文本原样返回', () => {
    assert.deepEqual(splitText('你好', 120), ['你好'])
  })

  it('空文本返回空数组', () => {
    assert.deepEqual(splitText('   ', 120), [])
  })

  it('按段落切分且每段不超限', () => {
    const text = ['第一段'.repeat(10), '第二段'.repeat(10), '第三段'.repeat(10)].join('\n\n')
    const chunks = splitText(text, 60)
    assert.ok(chunks.length > 1)
    for (const chunk of chunks) assert.ok(chunk.length <= 60, `chunk 超限: ${String(chunk.length)}`)
  })

  it('单段超过上限时硬切', () => {
    const chunks = splitText('啊'.repeat(250), 100)
    assert.equal(chunks.length, 3)
    for (const chunk of chunks) assert.ok(chunk.length <= 100)
  })

  it('sentence 模式按句末标点切', () => {
    const text = '第一句。第二句！第三句？'
    const chunks = splitText(text, 8, 'sentence')
    assert.ok(chunks.length >= 2)
    assert.equal(chunks.join(''), text)
  })

  it('none 模式不切', () => {
    const text = '啊'.repeat(250)
    assert.deepEqual(splitText(text, 100, 'none'), [text])
  })

  it('切口落在代码块里时补上闭合符号', () => {
    const text = `说明：\n\n${'```'}js\n${'const a = 1\n'.repeat(20)}${'```'}`
    const chunks = splitText(text, 80)
    assert.ok(chunks.length > 1)
    for (const chunk of chunks) {
      const fences = chunk.split('```').length - 1
      assert.equal(fences % 2, 0, `片段代码块未闭合：\n${chunk}`)
    }
  })

  it('切分不丢字符（无代码块时）', () => {
    const text = '第一段内容'.repeat(20)
    const chunks = splitText(text, 50)
    assert.equal(chunks.join(''), text)
  })
})
