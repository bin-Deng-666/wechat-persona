/** 会话设置：解析、联系人目录隔离、旧目录迁移与热更新。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ChatSettingsStore, DEFAULT_CHAT_SETTINGS, parseChatSettings } from '../../src/chat/settings.ts'

const dirs: string[] = []
async function root() { const dir = await mkdtemp(join(tmpdir(), 'chat-settings-')); dirs.push(dir); return dir }
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }) })

const directory = (peerId: string) => createHash('sha256').update(peerId).digest('hex')
const legacyDirectory = (peerId: string) => encodeURIComponent(peerId).replaceAll('%', '_')

describe('parseChatSettings', () => {
  it('空对象和坏输入回落默认值', () => {
    for (const value of [{}, null, 'nope']) assert.deepEqual(parseChatSettings(value), DEFAULT_CHAT_SETTINGS)
  })
  it('坏字段逐项丢弃，主动搭话字段不再生效', () => {
    assert.deepEqual(parseChatSettings({ personaId: ' jarvis ', enabled: false, maxChars: 'big' }), { enabled: false, personaId: 'jarvis' })
  })
  it('maxChars 有边界，空人格不绑定', () => {
    assert.equal(parseChatSettings({ maxChars: 1 }).maxChars, 20)
    assert.equal(parseChatSettings({ maxChars: 99_999 }).maxChars, 4096)
    assert.equal(parseChatSettings({ personaId: ' ' }).personaId, undefined)
  })
})

describe('ChatSettingsStore', () => {
  it('不存在时返回默认值，保存后可读回', async () => {
    const store = new ChatSettingsStore(await root())
    assert.deepEqual(await store.get('u1'), DEFAULT_CHAT_SETTINGS)
    const value = { enabled: true, personaId: 'jarvis', maxChars: 80 }
    await store.save('u1', value)
    assert.deepEqual(await store.get('u1'), value)
  })

  it('按联系人哈希建目录，特殊 peer 可恢复真实 ID', async () => {
    const dir = await root()
    const store = new ChatSettingsStore(dir)
    await store.save('a/b:c', { enabled: true })
    assert.deepEqual(JSON.parse(await readFile(join(dir, directory('a/b:c'), 'settings.json'), 'utf8')), { peerId: 'a/b:c', enabled: true })
    assert.deepEqual(await store.listPeers(), ['a/b:c'])
    assert.deepEqual(await new ChatSettingsStore(dir).get('a/b:c'), { enabled: true })
  })

  it('旧转义目录会碰撞的 peer 不会互相读到设置', async () => {
    // 旧目录名把 % 换成 _：`/` 编成 `%2F` 再变 `_2F`，与字面量 `_2F` 落到同一目录。
    assert.equal(legacyDirectory('/'), legacyDirectory('_2F'))
    const dir = await root()
    const store = new ChatSettingsStore(dir)
    await store.save('/', { enabled: false, personaId: 'slash' })
    await store.save('_2F', { enabled: true, personaId: 'underscore' })
    assert.deepEqual(await store.get('/'), { enabled: false, personaId: 'slash' })
    assert.deepEqual(await store.get('_2F'), { enabled: true, personaId: 'underscore' })
    assert.deepEqual((await store.listPeers()).sort(), ['/', '_2F'])
  })

  it('旧目录在身份匹配时仍可读取，写入转到哈希目录', async () => {
    const dir = await root()
    await mkdir(join(dir, legacyDirectory('legacy/user')), { recursive: true })
    await writeFile(join(dir, legacyDirectory('legacy/user'), 'settings.json'), JSON.stringify({ peerId: 'legacy/user', enabled: true, maxChars: 200 }), 'utf8')
    const store = new ChatSettingsStore(dir)
    assert.deepEqual(await store.get('legacy/user'), { enabled: true, maxChars: 200 })
    assert.deepEqual(await store.listPeers(), ['legacy/user'])
    await store.update('legacy/user', current => ({ ...current, enabled: false }))
    assert.equal((await store.get('legacy/user')).enabled, false)
    assert.equal(JSON.parse(await readFile(join(dir, directory('legacy/user'), 'settings.json'), 'utf8')).peerId, 'legacy/user')
    // 旧文件保留供核对，不删除。
    assert.ok(await readFile(join(dir, legacyDirectory('legacy/user'), 'settings.json'), 'utf8'))
  })

  it('旧目录里的文档属于别的联系人时不会被误读', async () => {
    const dir = await root()
    await mkdir(join(dir, legacyDirectory('someone')), { recursive: true })
    await writeFile(join(dir, legacyDirectory('someone'), 'settings.json'), JSON.stringify({ peerId: 'other', enabled: false }), 'utf8')
    const store = new ChatSettingsStore(dir)
    assert.deepEqual(await store.get('someone'), DEFAULT_CHAT_SETTINGS)
    assert.deepEqual(await store.listPeers(), [])
  })

  it('缓存复用，文件修改后下一次读取生效', async () => {
    const dir = await root()
    const store = new ChatSettingsStore(dir)
    await store.save('u1', { enabled: true })
    const first = await store.get('u1')
    assert.equal(await store.get('u1'), first)
    const file = join(dir, directory('u1'), 'settings.json')
    await writeFile(file, JSON.stringify({ peerId: 'u1', enabled: false, maxChars: 200 }))
    const later = new Date(Date.now() + 1000)
    await utimes(file, later, later)
    assert.deepEqual(await store.get('u1'), { enabled: false, maxChars: 200 })
  })

  it('文档损坏时报错并保留原文件，不静默回落默认值', async () => {
    const dir = await root()
    const store = new ChatSettingsStore(dir)
    await store.save('u1', { enabled: true })
    const file = join(dir, directory('u1'), 'settings.json')
    await writeFile(file, '{ not json', 'utf8')
    await assert.rejects(new ChatSettingsStore(dir).get('u1'), /原文件已保留/)
    assert.equal(await readFile(file, 'utf8'), '{ not json')
  })

  it('空联系人被拒绝，不落到仓库根目录', async () => {
    const store = new ChatSettingsStore(await root())
    await assert.rejects(store.get(''), /不能为空/)
  })
})
