/**
 * iLink 协议层的测试：状态机（纯逻辑）+ 请求形状（注入的假 fetch）。
 * 不连网、不碰真实微信。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildBaseInfo,
  buildClientVersion,
  BusinessError,
  classifyFetchError,
  createApiClient,
  asWeixinMessage,
} from '../../src/ilink/api.ts'


describe('buildClientVersion / buildBaseInfo', () => {
  it('把 1.2.3 编成 0x00010203', () => {
    assert.equal(buildClientVersion('1.2.3'), 0x00010203)
  })

  it('非法版本号当作 0', () => {
    assert.equal(buildClientVersion('x.y.z'), 0)
  })

  it('bot agent 空白时回落到默认值', () => {
    assert.equal(buildBaseInfo({ botAgent: '  ' }).bot_agent, 'wechat-persona')
  })

  it('过长的 bot agent 被截断', () => {
    assert.equal(buildBaseInfo({ botAgent: 'a'.repeat(999) }).bot_agent.length, 256)
  })
})

describe('classifyFetchError', () => {
  it('AbortError 归为超时', () => {
    const error = Object.assign(new Error('aborted'), { name: 'AbortError' })
    assert.equal(classifyFetchError(error).type, 'timeout')
  })

  it('ENOTFOUND 归为 DNS', () => {
    assert.equal(classifyFetchError(new Error('getaddrinfo ENOTFOUND host')).type, 'dns')
  })

  it('未知错误归为 unknown', () => {
    assert.equal(classifyFetchError(new Error('boom')).type, 'unknown')
  })
})

describe('createApiClient', () => {
  /** 记录请求的假 fetch。 */
  function recorder(response: { body?: string; status?: number; headers?: Record<string, string> } = {}) {
    const calls: { url: string; init: RequestInit }[] = []
    const impl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} })
      return new Response(response.body ?? '{"ret":0}', { status: response.status ?? 200, headers: response.headers })
    }
    return { calls, impl }
  }

  it('带上协议要求的请求头', async () => {
    const { calls, impl } = recorder()
    const client = createApiClient({ fetchImpl: impl, channelVersion: '1.0.2' })
    await client.sendText({ baseUrl: 'https://ilinkai.weixin.qq.com', endpoint: 'ilink/bot/sendmessage', label: 'sendmessage', token: 'tok', to: 'u1', text: 'hi' })
    const headers = calls[0]?.init.headers as Record<string, string>
    assert.equal(headers['AuthorizationType'], 'ilink_bot_token')
    assert.equal(headers['Authorization'], 'Bearer tok')
    assert.equal(headers['iLink-App-Id'], 'bot')
    assert.equal(headers['iLink-App-ClientVersion'], String(buildClientVersion('1.0.2')))
    assert.match(headers['X-WECHAT-UIN'] ?? '', /^[A-Za-z0-9+/]+=*$/)
  })

  it('sendText 的 body 含必填字段与 context_token', async () => {
    const { calls, impl } = recorder()
    const client = createApiClient({ fetchImpl: impl })
    await client.sendText({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      endpoint: 'ilink/bot/sendmessage',
      label: 'sendmessage',
      token: 'tok',
      to: 'u1',
      text: '你好',
      contextToken: 'ctx-1',
    })
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      msg: Record<string, unknown> & { item_list: unknown[] }
      base_info: { channel_version: string }
    }
    assert.equal(body.msg['to_user_id'], 'u1')
    assert.equal(body.msg['message_type'], 2)
    assert.equal(body.msg['message_state'], 2)
    assert.equal(body.msg['context_token'], 'ctx-1')
    assert.deepEqual(body.msg.item_list, [{ type: 1, text_item: { text: '你好' } }])
    assert.ok(typeof body.base_info.channel_version === 'string')
  })

  it('sendText 在 HTTP 200 但带错误码时抛 BusinessError', async () => {
    const { impl } = recorder({ body: '{"ret":-2,"errmsg":"prepare failed"}' })
    const client = createApiClient({ fetchImpl: impl })
    await assert.rejects(
      client.sendText({ baseUrl: 'https://x.cn', endpoint: 'ilink/bot/sendmessage', label: 'sendmessage', token: 't', to: 'u', text: 'hi' }),
      (error: unknown) => error instanceof BusinessError && error.code === -2,
    )
  })

  it('getUpdates 首次发空游标，并解析出 msgs 与游标', async () => {
    const { calls, impl } = recorder({
      body: JSON.stringify({ ret: 0, msgs: [{ from_user_id: 'u1' }], get_updates_buf: 'cursor-2', longpolling_timeout_ms: 35000 }),
    })
    const client = createApiClient({ fetchImpl: impl })
    const result = await client.getUpdates({ baseUrl: 'https://x.cn', endpoint: 'ilink/bot/getupdates', label: 'getupdates', token: 't' })
    assert.equal(JSON.parse(String(calls[0]?.init.body)).get_updates_buf, '')
    assert.equal(result.msgs.length, 1)
    assert.equal(result.get_updates_buf, 'cursor-2')
    assert.equal(result.longpolling_timeout_ms, 35000)
  })

  it('getUpdates 把 -14（会话失效）抛成 BusinessError', async () => {
    const { impl } = recorder({ body: '{"errcode":-14,"errmsg":"session expired"}' })
    const client = createApiClient({ fetchImpl: impl })
    await assert.rejects(
      client.getUpdates({ baseUrl: 'https://x.cn', endpoint: 'ilink/bot/getupdates', label: 'getupdates', token: 't' }),
      (error: unknown) => error instanceof BusinessError && error.code === -14,
    )
  })

  it('getConfig 只在 ret=0 时返回票据', async () => {
    const ok = recorder({ body: '{"ret":0,"typing_ticket":"tkt"}' })
    const denied = recorder({ body: '{"ret":1,"typing_ticket":"should-not-cache"}' })
    const params = { baseUrl: 'https://x.cn', endpoint: 'ilink/bot/getconfig', label: 'getconfig', token: 't', userId: 'u' }
    assert.equal(await createApiClient({ fetchImpl: ok.impl }).getConfig(params), 'tkt')
    assert.equal(await createApiClient({ fetchImpl: denied.impl }).getConfig(params), '')
  })

  it('非 2xx 抛 HttpStatusError 并保留 body', async () => {
    const { impl } = recorder({ status: 503, body: 'unavailable' })
    const client = createApiClient({ fetchImpl: impl })
    await assert.rejects(
      client.get({ baseUrl: 'https://x.cn', endpoint: 'ilink/bot/getupdates', label: 'get' }),
      (error: unknown) => error instanceof Error && error.name === 'HttpStatusError',
    )
  })

  it('baseUrl 缺尾斜杠不会吞掉路径段', async () => {
    const { calls, impl } = recorder()
    await createApiClient({ fetchImpl: impl }).get({ baseUrl: 'https://x.cn', endpoint: 'ilink/bot/getupdates', label: 'g' })
    assert.equal(calls[0]?.url, 'https://x.cn/ilink/bot/getupdates')
  })


  it('请求超时后中止，而不是无限挂起', async () => {
    // 用 ref 保持事件循环存活，否则未到 10ms 定时器就被判为悬空 Promise。
    const keepAlive = setTimeout(() => {}, 100)
    const impl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal === null || signal === undefined) return
        signal.addEventListener('abort', () => { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
      })
    try {
      const client = createApiClient({ fetchImpl: impl })
      await assert.rejects(
        client.sendText({ baseUrl: 'https://x.cn', endpoint: 'ilink/bot/sendmessage', label: 'sendmessage', token: 't', to: 'u', text: 'hi', timeoutMs: 10 }),
        (error: unknown) => (error as { classification?: { type?: string } }).classification?.type === 'timeout',
      )
    } finally {
      clearTimeout(keepAlive)
    }
  })

  it('调用方 signal 取消后请求被中断', async () => {
    const impl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal === null || signal === undefined) return
        signal.addEventListener('abort', () => { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
      })
    const controller = new AbortController()
    const client = createApiClient({ fetchImpl: impl })
    const pending = client.getUpdates({ baseUrl: 'https://x.cn', endpoint: 'ilink/bot/getupdates', label: 'g', token: 't', signal: controller.signal })
    controller.abort()
    await assert.rejects(pending)
  })
})

describe('asWeixinMessage', () => {
  it('没有 from_user_id 的丢弃', () => {
    assert.equal(asWeixinMessage({}), undefined)
    assert.equal(asWeixinMessage(null), undefined)
  })

  it('合法的原样返回', () => {
    assert.equal(asWeixinMessage({ from_user_id: 'u1' })?.from_user_id, 'u1')
  })
})
