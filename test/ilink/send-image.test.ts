import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { aesEcbPaddedSize, sendImage } from '../../src/ilink/send-image.ts'

describe('aesEcbPaddedSize', () => {
  it('按 PKCS#7 计算补位后的长度', () => {
    assert.equal(aesEcbPaddedSize(0), 16)
    assert.equal(aesEcbPaddedSize(15), 16)
    assert.equal(aesEcbPaddedSize(16), 32)
    assert.equal(aesEcbPaddedSize(17), 32)
  })
})

describe('sendImage', () => {
  function fakeApi(options: { uploadParam?: string; fullUrl?: string; sent?: Record<string, unknown>[] }) {
    const sent = options.sent ?? []
    return {
      sent,
      api: {
        getUploadUrl: async () => ({ uploadParam: options.uploadParam ?? 'up', uploadFullUrl: options.fullUrl }),
        sendImage: async (params: Record<string, unknown>) => { sent.push(params) },
      },
    }
  }

  function fakeFetch(header: string | null, status = 200) {
    const calls: { url: string; body: Uint8Array | undefined }[] = []
    const impl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: init?.body as Uint8Array | undefined })
      return new Response('', { status, headers: header === null ? {} : { 'x-encrypted-param': header } })
    }
    return { calls, impl }
  }

  it('走完 取上传地址 → 加密上传 → sendmessage', async () => {
    const { api, sent } = fakeApi({})
    const { calls, impl } = fakeFetch('download-param')
    await sendImage({
      api: api as never,
      baseUrl: 'https://api',
      token: 't',
      to: 'u1',
      data: Buffer.from('image-bytes'),
      fetchImpl: impl,
      cdnBaseUrl: 'https://cdn.example.com/c2c',
    })
    assert.equal(calls.length, 1)
    assert.match(calls[0]?.url ?? '', /^https:\/\/cdn\.example\.com\/c2c\/upload\?encrypted_query_param=up&filekey=/)
    // 上传的是密文，不是明文
    assert.notDeepEqual(Buffer.from(calls[0]?.body ?? []), Buffer.from('image-bytes'))
    assert.equal(sent.length, 1)
    assert.equal(sent[0]?.['encryptQueryParam'], 'download-param')
    assert.equal(sent[0]?.['ciphertextSize'], aesEcbPaddedSize('image-bytes'.length))
    assert.ok(typeof sent[0]?.['aesKeyBase64'] === 'string')
    // 图片的 aes_key 必须是「hex 字符串再 base64」；对 16 字节直接 base64 会让收件人解不开。
    const decoded = Buffer.from(sent[0]?.['aesKeyBase64'] as string, 'base64').toString('ascii')
    assert.match(decoded, /^[0-9a-f]{32}$/)
  })

  it('优先用 upload_full_url', async () => {
    const { api } = fakeApi({ fullUrl: 'https://cdn/direct' })
    const { calls, impl } = fakeFetch('p')
    await sendImage({ api: api as never, baseUrl: 'https://api', token: 't', to: 'u', data: Buffer.from('x'), fetchImpl: impl })
    assert.equal(calls[0]?.url, 'https://cdn/direct')
  })

  it('200 但没有 x-encrypted-param 视为失败', async () => {
    const { api, sent } = fakeApi({})
    const { impl } = fakeFetch(null)
    await assert.rejects(
      sendImage({ api: api as never, baseUrl: 'https://api', token: 't', to: 'u', data: Buffer.from('x'), fetchImpl: impl }),
      /x-encrypted-param/,
    )
    assert.equal(sent.length, 0)
  })

  it('4xx 直接失败且不重试', async () => {
    const { api } = fakeApi({})
    let calls = 0
    const impl: typeof fetch = async () => { calls += 1; return new Response('', { status: 403 }) }
    await assert.rejects(sendImage({ api: api as never, baseUrl: 'https://api', token: 't', to: 'u', data: Buffer.from('x'), fetchImpl: impl }))
    assert.equal(calls, 1)
  })

  it('5xx 会重试', async () => {
    const { api, sent } = fakeApi({})
    let calls = 0
    const impl: typeof fetch = async () => {
      calls += 1
      return calls === 1
        ? new Response('', { status: 503 })
        : new Response('', { status: 200, headers: { 'x-encrypted-param': 'p' } })
    }
    await sendImage({ api: api as never, baseUrl: 'https://api', token: 't', to: 'u', data: Buffer.from('x'), fetchImpl: impl })
    assert.equal(calls, 2)
    assert.equal(sent.length, 1)
  })
})
