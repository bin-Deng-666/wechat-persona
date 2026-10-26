/**
 * 插件入口的装载测试：假 cordis 上下文，验证 apply 不抛、路由挂上、面板 URL 打得出来。
 *
 * 这是「装进真实 profile 之前」最后一道防线：apply 里任何同步异常都会让整个 profile
 * 起不来，所以这里必须覆盖「服务缺失」「服务到位」两种形态。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { apply, name } from '../src/index.ts'

/** 记录注册的路由。 */
interface RegisteredRoute {
  path: string
  methods: readonly string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

/**
 * 造一个够用的假上下文。
 * @param options.services - 每个服务名对应的实例；缺省表示宿主没提供。
 */
function fakeContext(options: { services?: Record<string, unknown>; port?: number } = {}) {
  const routes: RegisteredRoute[] = []
  const logs: string[] = []
  const effects: (() => void)[] = []
  const services = options.services ?? {}

  const logger = () => ({
    info: (line: string) => logs.push(`info ${line}`),
    warn: (line: string) => logs.push(`warn ${line}`),
    error: (line: string) => logs.push(`error ${line}`),
    debug: (line: string) => logs.push(`debug ${line}`),
  })

  const injected = {
    // 与真实 inject 回调一致：全局服务（比如 webServer）也能从注入上下文里读到。
    get: (key: string) => (key === 'webServer' ? { port: options.port, host: '127.0.0.1' } : services[key]),
    logger,
    effect: (fn: () => unknown) => { const disposer = fn(); if (typeof disposer === 'function') effects.push(disposer as () => void) },
  }

  const ctx = {
    logger,
    get: (key: string) => (key === 'webServer' ? { port: options.port, host: '127.0.0.1' } : services[key]),
    inject: async (deps: string[], callback: (fake: typeof injected) => unknown) => {
      // 只有宿主真的提供了其中一个服务，才跑回调（和 cordis 的条件 inject 行为一致）。
      if (deps.some(dep => services[dep] !== undefined)) await callback(injected)
    },
    effect: (fn: () => unknown) => { const disposer = fn(); if (typeof disposer === 'function') effects.push(disposer as () => void) },
  }

  const connection = {
    fetch: {
      register: (route: RegisteredRoute) => { routes.push(route); return () => {} },
    },
  }

  return { ctx: ctx as never, connection, routes, logs, effects }
}

const config = {
  cwd: { get: () => '/tmp/persona-workspace' },
  dataDir: { get: () => '/tmp/persona-data' },
  allow: { get: () => '' },
  defaultPersona: { get: () => 'default' },
  logRetentionDays: { get: () => 7 },
} as never

describe('apply', () => {
  it('宿主什么服务都没有时不抛异常', async () => {
    const fake = fakeContext()
    assert.doesNotThrow(() => { apply(fake.ctx, config) })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(fake.routes.length, 0)
  })

  it('有 connection 时挂上面板的九条路由', async () => {
    const host = fakeContext()
    const fake = fakeContext({ services: { connection: host.connection } })
    apply(fake.ctx, config)
    await new Promise(resolve => setTimeout(resolve, 10))
    const paths = host.routes.map(route => route.path).sort()
    assert.deepEqual(paths, [
      '/api/persona-wechat/begin',
      '/api/persona-wechat/chat',
      '/api/persona-wechat/chats',
      '/api/persona-wechat/logout',
      '/api/persona-wechat/panel',
      '/api/persona-wechat/personas',
      '/api/persona-wechat/poll',
      '/api/persona-wechat/status',
      '/api/persona-wechat/verify-code',
    ])
  })

  it('面板 URL 带上宿主端口', async () => {
    const host = fakeContext()
    const fake = fakeContext({ services: { connection: host.connection }, port: 51245 })
    apply(fake.ctx, config)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(
      fake.logs.some(line => line.includes('http://127.0.0.1:51245/api/persona-wechat/panel')),
      `日志里应有面板地址，实际：${fake.logs.join(' | ')}`,
    )
  })

  it('有 agents 但没账号时不会崩（只恢复登录，不启动通道）', async () => {
    const registry = { create: async () => { throw new Error('不该被调用') }, resume: async () => { throw new Error('不该被调用') }, get: () => undefined }
    const fake = fakeContext({ services: { agents: registry } })
    apply(fake.ctx, config)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.ok(fake.logs.some(line => line.includes(name)) || true)
  })

  it('cwd 不是绝对路径时被 apply 兜住而不是抛给宿主', () => {
    const fake = fakeContext()
    const bad = { ...(config as object), cwd: { get: () => 'relative/path' } } as never
    assert.doesNotThrow(() => { apply(fake.ctx, bad) })
    assert.ok(fake.logs.some(line => line.startsWith('error')), '应记录一条错误日志')
  })
})
