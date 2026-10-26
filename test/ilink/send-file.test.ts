/**
 * 发文件：协议细节最容易错的三处——media_type、aes_key 拼法、len 是明文字符串。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { sanitizeName, sendFile } from '../../src/ilink/send-file.ts'
import { aesEcbPaddedSize } from '../../src/ilink/upload.ts'

describe('sanitizeName', () => {
  it('去掉路径，只留文件名', () => {
    assert.equal(sanitizeName('/Users/x/Desktop/月度总结.docx'), '月度总结.docx')
    assert.equal(sanitizeName('..\\..\\etc\\passwd'), 'passwd')
  })

  it('空名字与纯点号有兜底', () => {
    assert.equal(sanitizeName(''), 'file')
    assert.equal(sanitizeName('..'), 'file')
    assert.equal(sanitizeName('   '), 'file')
  })

  it('控制字符被去掉', () => {
    assert.equal(sanitizeName('a\u0000b\u001fc.txt'), 'abc.txt')
  })

  it('过长名字被截断', () => {
    assert.equal(sanitizeName('x'.repeat(300)).length, 120)
  })
})

describe('sendFile', () => {
  function fakeApi() {
    const uploads: Record<string, unknown>[] = []
    const sent: Record<string, unknown>[] = []
    return {
      uploads,
      sent,
      api: {
        getUploadUrl: async (params: Record<string, unknown>) => {
          uploads.push(params)
          return { uploadParam: 'up', uploadFullUrl: undefined }
        },
        sendFile: async (params: Record<string, unknown>) => { sent.push(params) },
      },
    }
  }

  function fakeFetch() {
    const calls: { url: string; body: Uint8Array | undefined }[] = []
    const impl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: init?.body as Uint8Array | undefined })
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'dl' } })
    }
    return { calls, impl }
  }

  it('用 media_type=3 申请上传，用 type=4 发送', async () => {
    const { api, uploads, sent } = fakeApi()
    const { impl } = fakeFetch()
    const data = Buffer.from('hello file')
    await sendFile({
      api: api as never,
      baseUrl: 'https://api',
      token: 't',
      to: 'u1',
      data,
      fileName: '/tmp/报告.docx',
      fetchImpl: impl,
      cdnBaseUrl: 'https://cdn.example.com/c2c',
    })

    assert.equal(uploads[0]?.['mediaType'], 3)
    assert.equal(uploads[0]?.['rawsize'], data.length)
    assert.equal(uploads[0]?.['filesize'], aesEcbPaddedSize(data.length))

    assert.equal(sent.length, 1)
    assert.equal(sent[0]?.['fileName'], '报告.docx')
    assert.equal(sent[0]?.['plaintextSize'], data.length)
    assert.equal(sent[0]?.['encryptQueryParam'], 'dl')
  })

  it('aes_key 是 hex 字符串的 base64（44 字符），不是 16 字节原样（24 字符）', async () => {
    const { api, sent } = fakeApi()
    const { impl } = fakeFetch()
    await sendFile({
      api: api as never,
      baseUrl: 'https://api',
      token: 't',
      to: 'u',
      data: Buffer.from('x'),
      fileName: 'a.txt',
      fetchImpl: impl,
    })
    const key = sent[0]?.['aesKeyBase64'] as string
    assert.equal(key.length, 44)
    const hex = Buffer.from(key, 'base64').toString('utf8')
    assert.match(hex, /^[0-9a-f]{32}$/)
  })

  it('上下文令牌会回传', async () => {
    const { api, sent } = fakeApi()
    const { impl } = fakeFetch()
    await sendFile({
      api: api as never,
      baseUrl: 'https://api',
      token: 't',
      to: 'u',
      data: Buffer.from('x'),
      fileName: 'a.txt',
      contextToken: 'ctx-9',
      fetchImpl: impl,
    })
    assert.equal(sent[0]?.['contextToken'], 'ctx-9')
  })

  it('上传失败时拒绝，调用方才能回一句说明', async () => {
    const { api } = fakeApi()
    const impl: typeof fetch = async () => new Response('', { status: 500 })
    await assert.rejects(
      sendFile({ api: api as never, baseUrl: 'https://api', token: 't', to: 'u', data: Buffer.from('x'), fileName: 'a.txt', fetchImpl: impl }),
    )
  })
})
