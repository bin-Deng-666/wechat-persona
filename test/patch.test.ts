/**
 * 随包分发的 profile patch 必须和配置 schema 对得上。
 *
 * 这里出过一次真事故：patch 里写了 `allow: []`（数组），而 schema 要的是字符串，
 * 结果是插件在真实宿主里加载即失败——本机单测全绿也没发现，因为没人校验过这份 YAML。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { Config } from '../src/config.ts'

const root = join(import.meta.dirname, '..')

describe('cordis.patch.yml', () => {
  it('allow 是字符串而不是数组', async () => {
    const text = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
    assert.match(text, /allow:\s*''/u)
    assert.doesNotMatch(text, /allow:\s*\[\s*\]/u)
  })

  it('cwd 与 dataDir 都是 !!js 表达式（不写死某台机器的路径）', async () => {
    const text = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
    assert.match(text, /cwd:\s*!!js/u)
    assert.match(text, /dataDir:\s*!!js/u)
  })
})

describe('Config schema', () => {
  /** volatile 字段解析回来是带 `.get()` 的引用，不是裸值。 */
  function values(input: Record<string, unknown>): Record<string, unknown> {
    const parsed = Config(input as never) as Record<string, { get: () => unknown }>
    return Object.fromEntries(Object.entries(parsed).map(([key, ref]) => [key, ref.get()]))
  }

  it('只给必填项时能解析出默认值', () => {
    const parsed = values({ cwd: '/tmp' })
    assert.equal(parsed['dataDir'], 'data/wechat-persona')
    assert.equal(parsed['allow'], '')
    assert.equal(parsed['defaultPersona'], 'default')
    assert.equal(parsed['logRetentionDays'], 7)
    assert.equal(parsed['permission'], 'workspace-write')
  })

  it('allow 给数组会被 schema 拒绝（正是 patch 里写错的那种）', () => {
    assert.throws(() => { Config({ cwd: '/tmp', allow: [] } as never) })
  })

  it('只接受三档权限，拼错会被拒绝', () => {
    assert.equal(values({ cwd: '/tmp', permission: 'danger-full-access' })['permission'], 'danger-full-access')
    assert.throws(() => { Config({ cwd: '/tmp', permission: 'root' } as never) })
  })

  it('缺 cwd 会被拒绝', () => {
    assert.throws(() => { Config({} as never) })
  })
})
