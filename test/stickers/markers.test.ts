import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseStickerToken, parseStickerTokens, extractStickerAnnotations, splitStickerSegments } from '../../src/stickers/markers.ts'

describe('parseStickerToken', () => {
  it('抽出名字与剩余文字', () => {
    assert.deepEqual(parseStickerToken('好啊 [表情:开心]'), { name: '开心', text: '好啊' })
    assert.deepEqual(parseStickerToken('[表情：无语]'), { name: '无语', text: '' })
  })

  it('没有标记返回 undefined', () => {
    assert.equal(parseStickerToken('普通回复'), undefined)
  })

  it('空名字不算标记', () => {
    assert.equal(parseStickerToken('[表情:]'), undefined)
  })
})

describe('表情识别控制标记', () => {
  it('标记不进入微信正文，提取识别或忽略动作', () => {
    const id = 's_1234567890abcdef1234'
    assert.deepEqual(extractStickerAnnotations(`哈哈 [收录表情:${id}|开心|猫咪大笑|开心和赞同]`), {
      text: '哈哈', annotations: [{ id, name: '开心', description: '猫咪大笑', scenes: '开心和赞同' }],
    })
    assert.deepEqual(extractStickerAnnotations(`[忽略图片:${id}]`), { text: '', annotations: [{ id, ignore: true }] })
    assert.deepEqual(extractStickerAnnotations('正文[收录表情:编造的ID|名|描述|场景]'), { text: '正文', annotations: [] })
  })
})

describe('多条表情标记的解析', () => {
  it('逐张列出名字，正文里不留标记', () => {
    assert.deepEqual(parseStickerTokens('好[表情:a] 的[表情：b]'), { names: ['a', 'b'], text: '好 的' })
    assert.deepEqual(parseStickerTokens('[表情:单独]'), { names: ['单独'], text: '' })
    assert.deepEqual(parseStickerTokens('纯文字'), { names: [], text: '纯文字' })
  })
})

describe('splitStickerSegments', () => {
  it('按原文顺序切出文字与表情', () => {
    assert.deepEqual(splitStickerSegments('前[表情:开心]后'), [
      { kind: 'text', value: '前' },
      { kind: 'sticker', value: '开心' },
      { kind: 'text', value: '后' },
    ])
  })

  it('没有表情时只有一段文字', () => {
    assert.deepEqual(splitStickerSegments('纯文字'), [{ kind: 'text', value: '纯文字' }])
  })

  it('名字不合法时保留原文，不吞掉用户的字', () => {
    const longName = '名'.repeat(25)
    assert.deepEqual(splitStickerSegments(`看这个[表情:${longName}]`), [
      { kind: 'text', value: `看这个[表情:${longName}]` },
    ])
  })
})
