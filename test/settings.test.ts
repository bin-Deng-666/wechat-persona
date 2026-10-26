/** 会话设置：解析、热更新与旧字段淘汰。 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ChatSettingsStore, DEFAULT_CHAT_SETTINGS, parseChatSettings } from '../src/persona/settings.ts'

const dirs: string[] = []
async function root() { const dir = await mkdtemp(join(tmpdir(), 'chat-settings-')); dirs.push(dir); return dir }
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }) })

describe('parseChatSettings', () => {
  it('空对象和坏输入回落默认值', () => {
    for (const value of [{}, null, 'nope']) assert.deepEqual(parseChatSettings(value), DEFAULT_CHAT_SETTINGS)
  })
  it('坏字段逐项丢弃，主动搭话字段不再生效', () => {
    assert.deepEqual(parseChatSettings({ personaId: ' xiao-jing ', enabled: false, maxChars: 'big' }), { enabled: false, personaId: 'xiao-jing' })
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
    const value = { enabled: true, personaId: 'xiao-jing', maxChars: 80 }
    await store.save('u1', value)
    assert.deepEqual(await store.get('u1'), value)
  })
  it('缓存复用，特殊 peer 和真实 ID 可恢复', async () => {
    const store = new ChatSettingsStore(await root())
    await store.save('a/b:c', { enabled: true })
    const first = await store.get('a/b:c')
    assert.equal(await store.get('a/b:c'), first)
    assert.deepEqual(await store.listPeers(), ['a/b:c'])
  })
  it('文件修改后下一次读取生效', async () => {
    const dir = await root()
    const store = new ChatSettingsStore(dir)
    await store.save('u1', { enabled: true })
    await store.get('u1')
    const file = join(dir, 'u1', 'settings.json')
    await writeFile(file, JSON.stringify({ peerId: 'u1', enabled: false, maxChars: 200 }))
    const later = new Date(Date.now() + 1000)
    await utimes(file, later, later)
    assert.deepEqual(await store.get('u1'), { enabled: false, maxChars: 200 })
  })
})
