/** 出站 aes_key 的编码：必须是「hex 字符串再 base64」，否则收件人解不开（表现为图片已过期）。 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { encodeAesKeyBase64 } from '../../src/ilink/upload.ts'

const KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex')

describe('encodeAesKeyBase64', () => {
  it('解出来是 32 位 hex 字符串，而不是 16 字节', () => {
    const encoded = encodeAesKeyBase64(KEY)
    const decoded = Buffer.from(encoded, 'base64')
    assert.equal(decoded.length, 32)
    assert.match(decoded.toString('ascii'), /^[0-9a-f]{32}$/)
    assert.equal(decoded.toString('ascii'), KEY.toString('hex'))
  })

  it('与「对 16 字节直接 base64」不同——这正是图片显示已过期的原因', () => {
    assert.notEqual(encodeAesKeyBase64(KEY), KEY.toString('base64'))
  })

  it('长度不变，且可被入站解析函数还原', async () => {
    const { parseAesKey } = await import('../../src/ilink/media.ts')
    assert.deepEqual(parseAesKey(encodeAesKeyBase64(KEY)), KEY)
  })
})
