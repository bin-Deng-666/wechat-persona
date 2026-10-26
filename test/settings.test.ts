/**
 * 每个聊天设置的测试：解析容错与落盘往返。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { ChatSettingsStore, DEFAULT_CHAT_SETTINGS, parseChatSettings } from '../src/persona/settings.ts'

const dirs: string[] = []

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chat-settings-'))
  dirs.push(dir)
  return dir
}

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

describe('parseChatSettings', () => {
  it('空对象得到默认值', () => {
    assert.deepEqual(parseChatSettings({}), DEFAULT_CHAT_SETTINGS)
    assert.deepEqual(parseChatSettings(null), DEFAULT_CHAT_SETTINGS)
    assert.deepEqual(parseChatSettings('nope'), DEFAULT_CHAT_SETTINGS)
  })

  it('坏字段逐项丢弃，好字段保留', () => {
    const settings = parseChatSettings({ personaId: '  xiao-jing ', enabled: false, maxChars: 'big', proactive: 'yes' })
    assert.equal(settings.personaId, 'xiao-jing')
    assert.equal(settings.enabled, false)
    assert.equal(settings.maxChars, undefined)
    assert.equal(settings.proactive, false)
  })

  it('maxChars 被夹到合法范围', () => {
    assert.equal(parseChatSettings({ maxChars: 1 }).maxChars, 20)
    assert.equal(parseChatSettings({ maxChars: 99_999 }).maxChars, 4_096)
    assert.equal(parseChatSettings({ maxChars: 300 }).maxChars, 300)
  })

  it('空白 personaId 视为未设置', () => {
    assert.equal(parseChatSettings({ personaId: '   ' }).personaId, undefined)
  })
})

describe('ChatSettingsStore', () => {
  it('没有文件时返回默认值', async () => {
    const store = new ChatSettingsStore(join(await makeRoot(), 'chats'))
    assert.deepEqual(await store.get('wxid-1'), DEFAULT_CHAT_SETTINGS)
  })

  it('保存后能读回', async () => {
    const root = await makeRoot()
    const store = new ChatSettingsStore(root)
    await store.save('wxid-1', { enabled: true, proactive: true, personaId: 'xiao-jing', maxChars: 80 })
    const loaded = await store.get('wxid-1')
    assert.deepEqual(loaded, { enabled: true, proactive: true, personaId: 'xiao-jing', maxChars: 80 })
  })

  it('同一个 store 第二次读命中缓存', async () => {
    const store = new ChatSettingsStore(await makeRoot())
    await store.save('wxid-1', { enabled: false, proactive: false })
    const first = await store.get('wxid-1')
    const second = await store.get('wxid-1')
    assert.equal(first, second)
  })

  it('含特殊字符的 peerId 也能落盘', async () => {
    const store = new ChatSettingsStore(await makeRoot())
    await store.save('a/b:c', { enabled: true, proactive: false })
    assert.deepEqual(await store.get('a/b:c'), { enabled: true, proactive: false })
  })

  it('listPeers 返回真实 peer id', async () => {
    const store = new ChatSettingsStore(await makeRoot())
    await store.save('wxid-1', { enabled: true, proactive: false })
    await store.save('a/b:c', { enabled: true, proactive: false })
    assert.deepEqual((await store.listPeers()).sort(), ['a/b:c', 'wxid-1'])
  })
})
