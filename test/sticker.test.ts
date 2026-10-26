/**
 * 发图与表情库的测试：假 api、假传输。
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { aesEcbPaddedSize, sendImage } from '../src/ilink/send-image.ts'
import { parseStickerToken, StickerLibrary } from '../src/persona/stickers.ts'

const dirs: string[] = []
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }) })

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

describe('StickerLibrary', () => {
  async function library() {
    const root = await mkdtemp(join(tmpdir(), 'stickers-'))
    dirs.push(root)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, '开心.png'), 'png')
    await writeFile(join(root, '无语.gif'), 'gif')
    await writeFile(join(root, '说明.txt'), 'not a sticker')
    return new StickerLibrary(root)
  }

  it('按名字找到文件，忽略非图片', async () => {
    const lib = await library()
    assert.match((await lib.find('开心')) ?? '', /开心\.png$/)
    assert.match((await lib.find('无语')) ?? '', /无语\.gif$/)
    assert.equal(await lib.find('说明'), undefined)
  })

  it('names 只列图片', async () => {
    const lib = await library()
    assert.deepEqual((await lib.names()).sort(), ['无语', '开心'].sort())
  })

  it('没有目录时返回空而不抛错', async () => {
    const lib = new StickerLibrary(join(tmpdir(), 'definitely-not-there-' + String(Date.now())))
    assert.deepEqual(await lib.names(), [])
  })
})
