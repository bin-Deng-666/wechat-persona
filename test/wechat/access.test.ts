/**
 * 准入名单与长文切分的测试。都是纯逻辑。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createAccessPolicy, parseAllowList } from '../../src/wechat/access.ts'

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
