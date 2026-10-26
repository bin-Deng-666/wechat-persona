import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sniffImageType } from '../../src/media/image.ts'

describe('sniffImageType', () => {
  it('识别 png / jpeg / gif / webp', () => {
    assert.equal(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
    assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
    assert.equal(sniffImageType(Buffer.from('GIF89a')), 'image/gif')
    assert.equal(sniffImageType(Buffer.from('RIFF....WEBP', 'ascii')), 'image/webp')
  })

  it('不是图片时返回 undefined', () => {
    assert.equal(sniffImageType(Buffer.from('%PDF-1.7')), undefined)
  })
})
