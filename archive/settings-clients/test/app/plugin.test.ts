/** 插件装载与设置页生命周期：使用假宿主，真实 HTTP 服务。 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { apply } from '../../src/index.ts'
import { rpcCall } from '../../src/panel/rpc.ts'
import { hostSocket } from '../../src/panel/config.ts'

async function setup(t: TestContext, connected = true) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-plugin-'))
  const routes: { path: string; fetch: (request: Request) => Promise<Response> }[] = []
  const webRoutes: { path: string }[] = [], logs: string[] = [], effects: (() => void)[] = []
  const logger = () => ({ info: (text: string) => logs.push(text), warn: (text: string) => logs.push(text), error: (text: string) => logs.push(text) })
  const services: Record<string, unknown> = connected ? {
    connection: { fetch: { register: (route: typeof routes[number]) => { routes.push(route); return () => {} } } },
    webServer: { register: (route: { path: string }) => { webRoutes.push(route); return () => {} } },
  } : {}
  const ctx = {
    get: (key: string) => services[key], logger,
    effect: (fn: () => unknown) => { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose as () => void) },
    inject: async (deps: string[], callback: (ctx: unknown) => unknown) => { if (deps.every(dep => services[dep])) await callback(ctx) },
  }
  const config = { cwd: { get: () => root }, dataDir: { get: () => root }, allow: { get: () => '' }, defaultPersona: { get: () => 'default' }, logRetentionDays: { get: () => 7 } }
  t.after(async () => { effects.forEach(dispose => dispose()); await new Promise(resolve => setTimeout(resolve, 30)); await rm(root, { force:true,recursive:true }) })
  return { root, ctx:ctx as never, config:config as never, routes, webRoutes, logs }
}

async function ready(logs: string[]): Promise<string> {
  for (let n = 0; n < 100; n++) {
    const line = logs.find(text => text.startsWith('设置页：http'))
    if (line) return line.slice('设置页：'.length)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('设置页没有启动：' + logs.join(' | '))
}

describe('apply', () => {
  it('无宿主服务时不抛异常，也不注册入口', async t => {
    const { ctx, config, routes } = await setup(t,false)
    assert.doesNotThrow(() => apply(ctx,config)); assert.equal(routes.length,0)
  })
  it('插件仅创建本机控制桥，不拥有网页服务生命周期', async t => {
    const fake = await setup(t); apply(fake.ctx,fake.config)
    const url = await ready(fake.logs)
    assert.match(url,/127\.0\.0\.1:32741\/persona-wechat\/panel$/)
    assert.deepEqual(fake.routes,[]); assert.deepEqual(fake.webRoutes,[])
    assert.deepEqual(await rpcCall(hostSocket(fake.root),'health'),{ok:true})
    const status = await rpcCall<{botOnline:boolean}>(hostSocket(fake.root),'status')
    assert.equal(status.botOnline,false)
  })
  it('本机控制桥拒绝未声明的方法', async t => {
    const fake = await setup(t); apply(fake.ctx,fake.config); await ready(fake.logs)
    await assert.rejects(rpcCall(hostSocket(fake.root),'readFile',{path:'/etc/passwd'}),/没有这个/)
  })
  it('cwd 相对路径由 apply 兜住，记录错误', async t => {
    const fake = await setup(t)
    apply(fake.ctx,{ ...(fake.config as object),cwd:{get:() => 'relative'} } as never)
    assert.ok(fake.logs.some(line => line.includes('必须是绝对路径')))
    assert.equal(fake.routes.length,0)
  })
})
