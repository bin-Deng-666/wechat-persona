/**
 * 对话代次：默认 0、自增、落盘可恢复。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { PeerGenerations } from '../../src/chat/generations.ts'

const dirs: string[] = []
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }) })

async function makeFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'generations-'))
  dirs.push(dir)
  return join(dir, 'generations.json')
}

describe('PeerGenerations', () => {
  it('没记录过是 0', async () => {
    assert.equal(await new PeerGenerations(await makeFile()).get('u1'), 0)
  })

  it('bump 自增并落盘', async () => {
    const file = await makeFile()
    const store = new PeerGenerations(file)
    assert.equal(await store.bump('u1'), 1)
    assert.equal(await store.bump('u1'), 2)
    assert.equal(await store.get('u1'), 2)
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, number>
    assert.equal(raw['u1'], 2)
  })

  it('新实例读回同一份记录（重启不回到旧会话）', async () => {
    const file = await makeFile()
    await new PeerGenerations(file).bump('u1')
    assert.equal(await new PeerGenerations(file).get('u1'), 1)
  })

  it('不同 peer 互不影响', async () => {
    const store = new PeerGenerations(await makeFile())
    await store.bump('u1')
    assert.equal(await store.get('u2'), 0)
  })

  it('坏文件当成空记录而不是抛错', async () => {
    const file = await makeFile()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, 'not json', 'utf8')
    assert.equal(await new PeerGenerations(file).get('u1'), 0)
  })
})
