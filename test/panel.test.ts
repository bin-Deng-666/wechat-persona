/**
 * 面板路由的测试：真 Request/Response，假日志。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createPanel, PANEL_PREFIX } from '../src/channel/panel.ts'
import type { LoginView } from '../src/channel/login-session.ts'

const idle: LoginView = { phase: 'idle', message: '尚未开始' }

function handlers(overrides: Partial<Parameters<typeof createPanel>[0]> = {}) {
  const calls: string[] = []
  const base = {
    status: async () => { calls.push('status'); return { connected: false, login: idle, dataDir: '/tmp/d' } },
    begin: async () => { calls.push('begin'); return { phase: 'waiting', message: '扫码', qr: { url: 'https://qr', svg: '<svg></svg>' } } satisfies LoginView },
    poll: async () => { calls.push('poll'); return idle },
    verifyCode: async (code: string) => { calls.push(`verify:${code}`); return { phase: 'connected', message: '已连接' } satisfies LoginView },
    logout: async () => { calls.push('logout'); return idle },
    personas: async () => { calls.push('personas'); return [{ id: 'xiao-jing', name: '小鲸', description: '', warnings: [] }] },
    chats: async () => { calls.push('chats'); return [{ peerId: 'wxid-1', enabled: true, proactive: false }] },
    setChat: async (patch: { peerId: string; enabled?: boolean }) => {
      calls.push(`setChat:${patch.peerId}`)
      return { peerId: patch.peerId, enabled: patch.enabled ?? true, proactive: false }
    },
  }
  return { handlers: { ...base, ...overrides }, calls }
}

describe('panel routes', () => {
  it('页面是 HTML 且含关键元素', async () => {
    const { handlers: h } = handlers()
    const page = await createPanel(h).page().text()
    assert.match(page, /<!doctype html>/)
    assert.match(page, new RegExp(PANEL_PREFIX.replaceAll('/', '\\/')))
    assert.match(page, /微信人格通道/)
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

  it('chat 路由缺 peerId 时 400', async () => {
    const { handlers: h } = handlers()
    const response = await createPanel(h).setChat(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ enabled: true }) }))
    assert.equal(response.status, 400)
  })
})
