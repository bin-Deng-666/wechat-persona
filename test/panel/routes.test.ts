/**
 * 面板路由的测试：真 Request/Response，假日志。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createPanel, withKey } from '../../src/panel/routes.ts'
import type { LoginView } from '../../src/auth/session.ts'

const idle: LoginView = { phase: 'idle', message: '尚未开始' }

function handlers(overrides: Partial<Parameters<typeof createPanel>[0]> = {}) {
  const calls: string[] = []
  const base = {
    status: async () => { calls.push('status'); return { connected: false, login: idle, dataDir: '/tmp/d' } },
    begin: async () => { calls.push('begin'); return { phase: 'waiting', message: '扫码', qr: { url: 'https://qr', svg: '<svg></svg>' } } satisfies LoginView },
    poll: async () => { calls.push('poll'); return idle },
    verifyCode: async (code: string) => { calls.push(`verify:${code}`); return { phase: 'connected', message: '已连接' } satisfies LoginView },
    logout: async () => { calls.push('logout'); return idle },
    personas: async () => { calls.push('personas'); return [{ id: 'jarvis', name: '贾维斯', description: '', warnings: [] }] },
    chats: async () => { calls.push('chats'); return [{ peerId: 'wxid-1', enabled: true }] },
    readPersona: async (id: string) => { calls.push(`read:${id}`); return { ok: true, raw: '{"id":"jarvis"}' } },
    writePersona: async (id: string, raw: string) => {
      calls.push(`write:${id}`)
      return raw.includes('bad') ? { ok: false, issues: ['prompt.identity: 缺少'], warnings: [] } : { ok: true, issues: [], warnings: [] }
    },
    setChat: async (patch: { peerId: string; enabled?: boolean }) => {
      calls.push(`setChat:${patch.peerId}`)
      return { peerId: patch.peerId, enabled: patch.enabled ?? true }
    },
  }
  return { handlers: { ...base, ...overrides }, calls }
}

describe('panel routes', () => {
  it('页面是 HTML 且含关键元素', async () => {
    const { handlers: h } = handlers()
    const page = await createPanel(h).page().text()
    assert.match(page, /<!doctype html>/)
    assert.match(page, /\/persona-wechat/)
    assert.match(page, /const KEY = new URLSearchParams/)
    assert.match(page, /微信人格通道/)
  })

  it('页面内联脚本语法合法（无顶层 await）', async () => {
    const { handlers: h } = handlers()
    const page = await createPanel(h).page().text()
    const match = /<script>([\s\S]*?)<\/script>/.exec(page)
    assert.ok(match?.[1] !== undefined, '页面应含内联脚本')
    // classic script 里出现顶层 await 会直接 SyntaxError，用 Function 构造器兜住。
    assert.doesNotThrow(() => { new Function(match[1] as string) })
    assert.match(match[1] as string, /void init\(\)/)
  })

  it('status 返回 JSON 且禁止缓存', async () => {
    const { handlers: h } = handlers()
    const response = await createPanel(h).status()
    assert.equal(response.headers.get('Content-Type')?.startsWith('application/json'), true)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.equal(((await response.json()) as { connected: boolean }).connected, false)
  })

  it('verify-code 拒绝非法输入，不调用处理器', async () => {
    const { handlers: h, calls } = handlers()
    const panel = createPanel(h)
    const bad = await panel.verifyCode(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ code: 'abc' }) }))
    assert.equal(bad.status, 400)
    assert.deepEqual(calls, [])

    const good = await panel.verifyCode(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ code: '123456' }) }))
    assert.equal(good.status, 200)
    assert.deepEqual(calls, ['verify:123456'])
  })

  it('verify-code 对非 JSON 请求体返回 400', async () => {
    const { handlers: h } = handlers()
    const response = await createPanel(h).verifyCode(new Request('http://local/x', { method: 'POST', body: 'not json' }))
    assert.equal(response.status, 400)
  })

  it('begin / poll / logout / personas 都能通', async () => {
    const { handlers: h, calls } = handlers()
    const panel = createPanel(h)
    assert.equal(((await (await panel.begin()).json()) as LoginView).phase, 'waiting')
    assert.equal(((await (await panel.poll()).json()) as LoginView).phase, 'idle')
    assert.equal(((await (await panel.logout()).json()) as LoginView).phase, 'idle')
    assert.equal(((await (await panel.personas()).json()) as unknown[]).length, 1)
    assert.deepEqual(calls, ['begin', 'poll', 'logout', 'personas'])
    assert.equal(((await (await panel.chats()).json()) as unknown[]).length, 1)
    const patched = await panel.setChat(new Request('http://local/x', {
      method: 'POST',
      body: JSON.stringify({ peerId: 'wxid-1', enabled: false }),
    }))
    assert.equal(patched.status, 200)
    assert.equal(((await patched.json()) as { enabled: boolean }).enabled, false)
    assert.ok(calls.includes('setChat:wxid-1'))
  })

  it('persona 读写路由', async () => {
    const { handlers: h } = handlers()
    const panel = createPanel(h)
    const read = await panel.readPersona(new Request('http://local/api/persona-wechat/persona?id=jarvis'))
    assert.equal(read.status, 200)
    assert.equal(((await read.json()) as { ok: boolean }).ok, true)

    const good = await panel.writePersona(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ id: 'jarvis', raw: '{}' }) }))
    assert.equal(good.status, 200)

    const badJson = await panel.writePersona(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ id: 'jarvis', raw: 'bad' }) }))
    assert.equal(badJson.status, 422)

    const badId = await panel.readPersona(new Request('http://local/x?id=BAD_ID'))
    assert.equal(badId.status, 400)
  })

  it('chat 路由缺 peerId 时 400', async () => {
    const { handlers: h } = handlers()
    const response = await createPanel(h).setChat(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ enabled: true }) }))
    assert.equal(response.status, 400)
  })
})


describe('withKey', () => {
  const handler = async (): Promise<Response> => new Response('ok')

  it('密钥正确才放行', async () => {
    const guarded = withKey(handler, 'secret')
    const good = await guarded(new Request('http://local/persona-wechat/panel?key=secret'))
    assert.equal(good.status, 200)

    const missing = await guarded(new Request('http://local/persona-wechat/panel'))
    assert.equal(missing.status, 401)

    const wrong = await guarded(new Request('http://local/persona-wechat/panel?key=nope'))
    assert.equal(wrong.status, 401)
  })

  it('长度不同的密钥也返回 401 而不是抛错', async () => {
    const guarded = withKey(handler, 'secret')
    assert.equal((await guarded(new Request('http://local/x?key='))).status, 401)
    assert.equal((await guarded(new Request('http://local/x?key=secrets'))).status, 401)
  })
})
