/** 当前插件只注册微信能力，不再创建设置 HTTP 服务或 Unix 控制桥。 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { apply } from '../../src/index.ts'

async function setup(t: TestContext, connected = true) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-plugin-'))
  const routes: unknown[] = [], webRoutes: unknown[] = [], logs: string[] = []
  const logger = () => ({ info: (text: string) => logs.push(text), warn: (text: string) => logs.push(text), error: (text: string) => logs.push(text) })
  const services: Record<string, unknown> = connected ? {
    connection: { fetch: { register: (route: unknown) => { routes.push(route) } } },
    webServer: { register: (route: unknown) => { webRoutes.push(route) } },
  } : {}
  const ctx = {
    get: (key: string) => services[key], logger,
    inject: async (deps: string[], callback: (ctx: unknown) => unknown) => { if (deps.every(dep => services[dep])) await callback(ctx) },
  }
  const config = { cwd: { get: () => root }, dataDir: { get: () => root }, allow: { get: () => '' }, defaultPersona: { get: () => 'default' }, logRetentionDays: { get: () => 7 } }
  t.after(async () => {
    // 默认人格初始化是异步操作，等它完成后再清理目录。
    for (let i = 0; i < 100; i++) {
      try { await access(join(root, 'personas/default/persona.json')); break } catch { await new Promise(resolve => setTimeout(resolve, 5)) }
    }
    await rm(root, { force: true, recursive: true })
  })
  return { root, ctx: ctx as never, config: config as never, routes, webRoutes, logs }
}

describe('apply', () => {
  it('无网页宿主服务时仍可装载', async t => {
    const fake = await setup(t, false)
    assert.doesNotThrow(() => apply(fake.ctx, fake.config))
    assert.ok(fake.logs.some(line => line.includes('已加载')))
  })
  it('有网页宿主也不注册路由或创建 settings 目录', async t => {
    const fake = await setup(t)
    apply(fake.ctx, fake.config)
    assert.deepEqual(fake.routes, [])
    assert.deepEqual(fake.webRoutes, [])
    assert.ok(!fake.logs.some(line => line.includes('设置页：')))
    await assert.rejects(readFile(join(fake.root, 'settings/service.json')), { code: 'ENOENT' })
    await assert.rejects(access(join(fake.root, 'settings/host.sock')), { code: 'ENOENT' })
  })
  it('相对 cwd 记录明确错误，不抛出到宿主', async t => {
    const fake = await setup(t)
    apply(fake.ctx, { ...(fake.config as object), cwd: { get: () => 'relative' } } as never)
    assert.ok(fake.logs.some(line => line.includes('必须是绝对路径')))
    assert.equal(fake.routes.length, 0)
  })
})
