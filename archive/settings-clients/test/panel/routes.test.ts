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
    memory: async (peerId: string) => { calls.push(`memory:${peerId}`); return { memories: [], legacy: ['旧版未核实'] } },
    saveMemory: async (input: { peerId: string; id?: string; title?: string }) => {
      calls.push(`saveMemory:${input.id ?? 'new'}:${input.title ?? ''}`)
      return input.title === '' ? { ok: false, issues: ['标题不能为空'] } : { ok: true, issues: [] }
    },
    deleteMemory: async (input: { peerId: string; id: string }) => { calls.push(`deleteMemory:${input.id}`); return { ok: true, issues: [] } },
    clearMemory: async (peerId: string) => { calls.push(`clearMemory:${peerId}`); return { ok: true } },
    stickers: async (peerId: string) => {
      calls.push(`stickers:${peerId}`)
      return { images: [{ id: 's_1', status: 'ready' as const, mediaType: 'image/png', bytes: 3, lastReceivedAt: '2026-10-26T00:00:00.000Z', name: '开心' }], shared: [{ name: '示例表情' }] }
    },
    stickerImage: async (input: { peerId: string; id: string }) => {
      calls.push(`stickerImage:${input.id}`)
      return input.id === 's_1' ? { data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png' } : undefined
    },
    saveSticker: async (input: { peerId: string; id: string; name?: string }) => {
      calls.push(`saveSticker:${input.id}:${input.name ?? ''}`)
      return input.name === '坏 名字' ? { ok: false, issues: ['名字不合法'] } : { ok: true, issues: [] }
    },
    forgetSticker: async (input: { peerId: string; id: string }) => { calls.push(`forgetSticker:${input.id}`); return { ok: true } },
    publishSticker: async (input: { peerId: string; id: string; name: string }) => { calls.push(`publishSticker:${input.name}`); return { ok: true, issues: [] } },
    unpublishSticker: async (name: string) => { calls.push(`unpublishSticker:${name}`); return { ok: true } },
  }
  return { handlers: { ...base, ...overrides }, calls }
}

describe('panel routes', () => {
  it('页面是 HTML 且含关键元素', async () => {
    const { handlers: h } = handlers()
    const page = await createPanel(h).page().text()
    assert.match(page, /<!doctype html>/)
    assert.match(page, /\/persona-wechat/)
    assert.match(page, /id="signInForm"/)
    assert.doesNotMatch(page, /const KEY =/)
    assert.match(page, /manifest\.webmanifest/)
    assert.match(page, /微信 Bot · 设置/)
    assert.match(page, /使用帮助/)
  })

  it('页面内联脚本语法合法（无顶层 await）', async () => {
    const { handlers: h } = handlers()
    const page = await createPanel(h).page().text()
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    assert.ok(scripts.length >= 1, '页面应含内联脚本')
    for (const script of scripts) assert.doesNotThrow(() => { new Function(script[1]!) })
    assert.match(page, /void run\(null,init\)/)
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

  it('memory 路由：缺 peerId 时 400，正常时返回记忆与旧版资料', async () => {
    const { handlers: h, calls } = handlers()
    const panel = createPanel(h)
    assert.equal((await panel.memory(new Request('http://local/x'))).status, 400)
    const ok = await panel.memory(new Request('http://local/x?peerId=wxid-1'))
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { memories: [], legacy: ['旧版未核实'] })
    assert.deepEqual(calls, ['memory:wxid-1'])
  })

  it('memory 保存：新增不需要 version，修改没有 version 时 400', async () => {
    const { handlers: h, calls } = handlers()
    const panel = createPanel(h)
    const added = await panel.saveMemory(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ peerId: 'wxid-1', title: '沟通偏好', content: '简单直接', type: '稳定偏好', scope: '沟通', certainty: '明确', tags: ['沟通'] }) }))
    assert.equal(added.status, 200)
    assert.ok(calls.includes('saveMemory:new:沟通偏好'))

    const missingVersion = await panel.saveMemory(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ peerId: 'wxid-1', id: 'm1', title: 'x', content: 'y', type: '稳定偏好' }) }))
    assert.equal(missingVersion.status, 400)

    const rejected = await panel.saveMemory(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ peerId: 'wxid-1', title: '', content: '', type: '稳定偏好' }) }))
    assert.equal(rejected.status, 422)
  })

  it('memory 删除需要 version', async () => {
    const { handlers: h, calls } = handlers()
    const panel = createPanel(h)
    assert.equal((await panel.deleteMemory(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ peerId: 'wxid-1', id: 'm1' }) }))).status, 400)
    assert.equal((await panel.deleteMemory(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ peerId: 'wxid-1', id: 'm1', version: 2 }) }))).status, 200)
    assert.deepEqual(calls, ['deleteMemory:m1'])
  })

  it('stickers 路由列出目录与共享；缺 peerId 时 400', async () => {
    const { handlers: h } = handlers()
    const panel = createPanel(h)
    assert.equal((await panel.stickers(new Request('http://local/x'))).status, 400)
    const ok = await panel.stickers(new Request('http://local/x?peerId=wxid-1'))
    assert.deepEqual(await ok.json(), { images: [{ id: 's_1', status: 'ready', mediaType: 'image/png', bytes: 3, lastReceivedAt: '2026-10-26T00:00:00.000Z', name: '开心' }], shared: [{ name: '示例表情' }] })
  })

  it('sticker/image 直接返回图片字节与类型，找不到时 404', async () => {
    const { handlers: h, calls } = handlers()
    const panel = createPanel(h)
    const found = await panel.stickerImage(new Request('http://local/x?peerId=wxid-1&id=s_1'))
    assert.equal(found.status, 200)
    assert.equal(found.headers.get('Content-Type'), 'image/png')
    assert.equal((await found.arrayBuffer()).byteLength, 4)

    assert.equal((await panel.stickerImage(new Request('http://local/x?peerId=wxid-1&id=missing'))).status, 404)
    assert.equal((await panel.stickerImage(new Request('http://local/x?id=s_1'))).status, 400)
    assert.ok(calls.includes('stickerImage:missing'))
  })

  it('sticker 保存与遗忘、共享与取消共享', async () => {
    const { handlers: h, calls } = handlers()
    const panel = createPanel(h)
    assert.equal((await panel.saveSticker(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ peerId: 'wxid-1', id: 's_1', name: '开心', description: '笑', scenes: '开心', status: 'ready' }) }))).status, 200)
    assert.equal((await panel.saveSticker(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ peerId: 'wxid-1', id: 's_1', name: '坏 名字' }) }))).status, 422)
    assert.equal((await panel.saveSticker(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ id: 's_1' }) }))).status, 400)
    assert.equal((await panel.forgetSticker(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ peerId: 'wxid-1', id: 's_1' }) }))).status, 200)
    assert.equal((await panel.publishSticker(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ peerId: 'wxid-1', id: 's_1', name: '开心' }) }))).status, 200)
    assert.equal((await panel.publishSticker(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ peerId: 'wxid-1', id: 's_1' }) }))).status, 400)
    assert.equal((await panel.unpublishSticker(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ name: '开心' }) }))).status, 200)
    assert.deepEqual(calls, ['saveSticker:s_1:开心', 'saveSticker:s_1:坏 名字', 'forgetSticker:s_1', 'publishSticker:开心', 'unpublishSticker:开心'])
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
