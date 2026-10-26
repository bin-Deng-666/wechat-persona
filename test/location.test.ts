/**
 * 位置：协议没有位置消息，只能展开成「名字 + 地图链接」。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { expandLocationTokens } from '../src/bridge/text.ts'

describe('expandLocationTokens', () => {
  it('带名字时输出名字与链接', () => {
    const text = expandLocationTokens('我在这：[位置:31.2304,121.4737,外滩]')
    assert.match(text, /📍 外滩/)
    assert.match(text, /https:\/\/maps\.apple\.com\/\?ll=31\.2304,121\.4737/)
    assert.doesNotMatch(text, /\[位置/)
  })

  it('没名字时用「位置」兜底', () => {
    const text = expandLocationTokens('[位置:31.23,121.47]')
    assert.match(text, /^位置/)
  })

  it('全角逗号与冒号也认', () => {
    const text = expandLocationTokens('[位置：31.23，121.47，公司]')
    assert.match(text, /公司/)
  })

  it('普通文本原样返回', () => {
    assert.equal(expandLocationTokens('没有位置'), '没有位置')
  })

  it('名字里带空格也能编码', () => {
    const text = expandLocationTokens('[位置:1,2,上海 外滩]')
    assert.match(text, /q=%E4%B8%8A%E6%B5%B7%20%E5%A4%96%E6%BB%A9/)
  })
})
