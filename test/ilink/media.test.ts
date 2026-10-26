/**
 * 媒体链路的测试：密钥解析、加解密往返、描述抽取、下载（假 fetch）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildCdnDownloadUrl, decryptAesEcb, downloadMedia, encryptAesEcb, extractMedia, parseAesKey } from '../../src/ilink/media.ts'

const KEY = Buffer.alloc(16, 7)

describe('parseAesKey', () => {
  it('16 字节 base64 直接当密钥', () => {
    assert.deepEqual(parseAesKey(KEY.toString('base64')), KEY)
  })

  it('32 字符 hex 的 base64 再解一次', () => {
    const hex = KEY.toString('hex')
    assert.deepEqual(parseAesKey(Buffer.from(hex, 'utf8').toString('base64')), KEY)
  })

  it('长度不对直接抛错', () => {
    assert.throws(() => parseAesKey(Buffer.from('short').toString('base64')))
  })
})

describe('AES-ECB 往返', () => {
  it('加密后能解回原文', () => {
    const plain = Buffer.from('你好，世界！这是一段用于测试的明文。', 'utf8')
    const cipher = encryptAesEcb(plain, KEY)
    assert.notDeepEqual(cipher, plain)
    assert.deepEqual(decryptAesEcb(cipher, KEY), plain)
  })
})

describe('buildCdnDownloadUrl', () => {
  it('对参数做 percent-encode（+ 不能变空格）', () => {
    const url = buildCdnDownloadUrl('a+b/c=', 'https://cdn.example.com/c2c')
    assert.equal(url, 'https://cdn.example.com/c2c/download?encrypted_query_param=a%2Bb%2Fc%3D')
  })

  it('基址带尾斜杠不会拼出 //', () => {
    assert.equal(buildCdnDownloadUrl('x', 'https://cdn.example.com/c2c/'), 'https://cdn.example.com/c2c/download?encrypted_query_param=x')
  })
})

describe('extractMedia', () => {
  it('图片的 hex aeskey 换算成 base64，并优先于 media.aes_key', () => {
    const hex = KEY.toString('hex')
    const media = extractMedia([{
      type: 2,
      image_item: { aeskey: hex, media: { encrypt_query_param: 'q', aes_key: 'ignored' } },
    }])
    assert.equal(media.length, 1)
    assert.equal(media[0]?.kind, 'image')
    assert.equal(media[0]?.aesKeyBase64, KEY.toString('base64'))
  })

  it('图片没有 hex aeskey 时退回 media.aes_key', () => {
    const media = extractMedia([{ type: 2, image_item: { media: { encrypt_query_param: 'q', aes_key: 'abc' } } }])
    assert.equal(media[0]?.aesKeyBase64, 'abc')
  })

  it('文件带名字；语音、视频按类型归位', () => {
    const media = extractMedia([
      { type: 3, voice_item: { media: { encrypt_query_param: 'v' } } },
      { type: 4, file_item: { file_name: 'a.pdf', media: { encrypt_query_param: 'f' } } },
      { type: 5, video_item: { media: { encrypt_query_param: 'm' } } },
    ])
    assert.deepEqual(media.map(item => item.kind), ['voice', 'file', 'video'])
    assert.equal(media[1]?.name, 'a.pdf')
  })

  it('没有下载参数也没有 full_url 的条目被丢弃', () => {
    assert.deepEqual(extractMedia([{ type: 2, image_item: { media: {} } }]), [])
    assert.deepEqual(extractMedia(undefined), [])
  })

  it('只有 full_url 也能用', () => {
    const media = extractMedia([{ type: 2, image_item: { media: { full_url: 'https://cdn/x' } } }])
    assert.equal(media[0]?.fullUrl, 'https://cdn/x')
  })
})

describe('downloadMedia', () => {
  const plain = Buffer.from('图片内容', 'utf8')

  function fakeFetch(body: Uint8Array, status = 200) {
    const urls: string[] = []
    const impl: typeof fetch = async input => {
      urls.push(String(input))
      return new Response(body as BodyInit, { status })
    }
    return { urls, impl }
  }

  it('无 key 时原样返回（对象是明文存储）', async () => {
    const { impl } = fakeFetch(plain)
    assert.deepEqual(await downloadMedia({ kind: 'image', encryptQueryParam: 'q' }, { fetchImpl: impl }), plain)
  })

  it('有 key 时解密', async () => {
    const cipher = encryptAesEcb(plain, KEY)
    const { impl } = fakeFetch(cipher)
    const result = await downloadMedia(
      { kind: 'image', encryptQueryParam: 'q', aesKeyBase64: KEY.toString('base64') },
      { fetchImpl: impl },
    )
    assert.deepEqual(result, plain)
  })

  it('优先用 full_url', async () => {
    const { impl, urls } = fakeFetch(plain)
    await downloadMedia({ kind: 'image', encryptQueryParam: 'q', fullUrl: 'https://cdn/obj' }, { fetchImpl: impl })
    assert.equal(urls[0], 'https://cdn/obj')
  })

  it('非 2xx 抛错', async () => {
    const { impl } = fakeFetch(plain, 404)
    await assert.rejects(downloadMedia({ kind: 'image', encryptQueryParam: 'q' }, { fetchImpl: impl }))
  })
})
