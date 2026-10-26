/**
 * 人格目录加载的测试：真文件系统，临时目录，不碰用户数据。
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { BUILTIN_DEFAULT, PersonaStore, seedDefaultPersona } from '../../src/persona/store.ts'

const created: string[] = []

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'persona-test-'))
  created.push(dir)
  return dir
}

async function writePersona(root: string, id: string, card: unknown): Promise<void> {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'persona.json'), JSON.stringify(card), 'utf8')
}

const validCard = {
  id: 'jarvis',
  name: '贾维斯',
  prompt: { identity: '你是{{name}}。' },
}

after(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true })
})

describe('PersonaStore', () => {
  it('目录不存在时返回空快照而不是抛异常', async () => {
    const root = join(await makeRoot(), 'not-yet')
    const snapshot = await new PersonaStore(root).snapshot()
    assert.equal(snapshot.personas.size, 0)
    assert.equal(snapshot.broken.length, 0)
  })

  it('加载合法卡片', async () => {
    const root = await makeRoot()
    await writePersona(root, 'jarvis', validCard)
    const snapshot = await new PersonaStore(root).snapshot()
    assert.equal(snapshot.personas.size, 1)
    assert.equal(snapshot.personas.get('jarvis')?.card.name, '贾维斯')
  })

  it('坏卡进 broken，不阻塞其它卡', async () => {
    const root = await makeRoot()
    await writePersona(root, 'jarvis', validCard)
    await writePersona(root, 'broken', { id: 'broken', name: '坏的' })
    const snapshot = await new PersonaStore(root).snapshot()
    assert.equal(snapshot.personas.size, 1)
    assert.equal(snapshot.broken.length, 1)
    assert.equal(snapshot.broken[0]?.id, 'broken')
    assert.ok(snapshot.broken[0]?.issues.some(issue => issue.path === 'prompt.identity'))
  })

  it('没有 persona.json 的目录被忽略', async () => {
    const root = await makeRoot()
    await mkdir(join(root, 'just-a-folder'), { recursive: true })
    const snapshot = await new PersonaStore(root).snapshot()
    assert.equal(snapshot.personas.size, 0)
    assert.equal(snapshot.broken.length, 0)
  })

  it('未变更的卡命中缓存（同一对象）', async () => {
    const root = await makeRoot()
    await writePersona(root, 'jarvis', validCard)
    const store = new PersonaStore(root)
    const first = await store.snapshot()
    const second = await store.snapshot()
    assert.equal(first.personas.get('jarvis'), second.personas.get('jarvis'))
  })

  it('删除人格目录后快照里也不再出现', async () => {
    const root = await makeRoot()
    await writePersona(root, 'jarvis', validCard)
    const store = new PersonaStore(root)
    assert.equal((await store.snapshot()).personas.size, 1)
    await rm(join(root, 'jarvis'), { recursive: true, force: true })
    assert.equal((await store.snapshot()).personas.size, 0)
  })

  it('resolve 在人格缺失时回落到内置默认', async () => {
    const root = await makeRoot()
    const snapshot = await new PersonaStore(root).snapshot()
    assert.equal(PersonaStore.resolve('nope', snapshot).id, BUILTIN_DEFAULT.id)
  })

  it('resolve 优先取指定人格', async () => {
    const root = await makeRoot()
    await writePersona(root, 'jarvis', validCard)
    const snapshot = await new PersonaStore(root).snapshot()
    assert.equal(PersonaStore.resolve('jarvis', snapshot).id, 'jarvis')
  })

  it('目录名与卡片 id 不一致时视为坏卡', async () => {
    const root = await makeRoot()
    await writePersona(root, 'folder-name', { ...validCard, id: 'other' })
    const snapshot = await new PersonaStore(root).snapshot()
    assert.equal(snapshot.personas.size, 0)
    assert.equal(snapshot.broken.length, 1)
  })
})

describe('seedDefaultPersona', () => {
  it('目录为空时写一张默认人格卡', async () => {
    const root = await makeRoot()
    assert.equal(await seedDefaultPersona(root), true)
    const snapshot = await new PersonaStore(root).snapshot()
    assert.equal(snapshot.personas.get('default')?.card.name, BUILTIN_DEFAULT.name)
  })

  it('已经有卡时不覆盖', async () => {
    const root = await makeRoot()
    await seedDefaultPersona(root)
    await writePersona(root, 'default', { id: 'default', name: '自定义', prompt: { identity: '你是自定义。' } })
    assert.equal(await seedDefaultPersona(root), false)
    assert.equal((await new PersonaStore(root).snapshot()).personas.get('default')?.card.name, '自定义')
  })
})
