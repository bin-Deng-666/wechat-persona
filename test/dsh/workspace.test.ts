/** 会话分组：只挂自己的会话，工作区按路径复用，失败可重试。 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { WorkspaceGrouper, type WorkspaceLike } from '../../src/dsh/workspace.ts'
import { SESSION_ID_PREFIX } from '../../src/dsh/sessions.ts'

function fakes(options: { failAttach?: string[] } = {}) {
  const created: { path: string; title: string | undefined }[] = []
  const attached: string[] = []
  const failed = new Set(options.failAttach ?? [])
  const registry = {
    create: async (path: string, title?: string): Promise<WorkspaceLike> => {
      created.push({ path, title })
      return {
        path,
        attachSession: async (sessionId: string) => {
          if (failed.has(sessionId)) throw new Error('header not persisted')
          attached.push(sessionId)
        },
      }
    },
  }
  const sessions = [
    { header: { id: `${SESSION_ID_PREFIX}u1`, cwd: '/work' } },
    { header: { id: `${SESSION_ID_PREFIX}u1~g1`, cwd: '/work' } },
    { header: { id: 'session-other', cwd: '/work' } },
    { header: { id: `${SESSION_ID_PREFIX}u2`, cwd: '/elsewhere' } },
    { header: { id: `${SESSION_ID_PREFIX}u3` } },
  ]
  const persistence = { list: async () => sessions }
  return { created, attached, registry, persistence }
}

describe('WorkspaceGrouper', () => {
  it('没有工作区注册表时整体不可用', () => {
    const grouper = new WorkspaceGrouper({ registry: () => undefined, persistence: () => undefined, cwd: '/work', title: '微信' })
    assert.equal(grouper.available, false)
  })

  it('只挂本插件前缀的会话，且只建一次工作区', async () => {
    const f = fakes()
    const grouper = new WorkspaceGrouper({ registry: () => f.registry, persistence: () => f.persistence, cwd: '/work', title: '微信' })
    assert.equal(await grouper.attach('session-other'), false)
    assert.equal(await grouper.attach(`${SESSION_ID_PREFIX}u1`), true)
    assert.equal(await grouper.attach(`${SESSION_ID_PREFIX}u1`), true)
    assert.deepEqual(f.created, [{ path: '/work', title: '微信' }])
    assert.deepEqual(f.attached, [`${SESSION_ID_PREFIX}u1`])
  })

  it('扫描只补齐 cwd 匹配且已持久化的本插件会话', async () => {
    const f = fakes()
    const grouper = new WorkspaceGrouper({ registry: () => f.registry, persistence: () => f.persistence, cwd: '/work', title: '微信' })
    const count = await grouper.sweep()
    assert.equal(count, 2)
    assert.deepEqual(f.attached.sort(), [`${SESSION_ID_PREFIX}u1`, `${SESSION_ID_PREFIX}u1~g1`].sort())
  })

  it('挂载失败会报告并允许下次重试', async () => {
    const reports: string[] = []
    const f = fakes({ failAttach: [`${SESSION_ID_PREFIX}u1`] })
    const grouper = new WorkspaceGrouper({ registry: () => f.registry, persistence: () => f.persistence, cwd: '/work', title: '微信', report: line => { reports.push(line) } })
    assert.equal(await grouper.attach(`${SESSION_ID_PREFIX}u1`), false)
    assert.ok(reports.some(line => line.includes('工作区')))
    f.created.length = 0
    // 第二次成功：失败的会话不会被记为已挂载，工作区句柄也会重建。
    assert.equal(await grouper.attach(`${SESSION_ID_PREFIX}u1~g1`), true)
    assert.equal(f.created.length, 1)
  })

  it('服务晚就绪时，注册表在调用时才被解析', async () => {
    const f = fakes()
    let registry: typeof f.registry | undefined
    const grouper = new WorkspaceGrouper({ registry: () => registry, persistence: () => f.persistence, cwd: '/work', title: '微信' })
    assert.equal(grouper.available, false)
    assert.equal(await grouper.sweep(), 0)
    registry = f.registry
    assert.equal(await grouper.attach(`${SESSION_ID_PREFIX}u1`), true)
  })
})
