/**
 * 通道运行时的测试：假 api、假会话、真 ReplyQueue。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Channel, textOf } from '../src/channel/runtime.ts'
import { createAccessPolicy } from '../src/bridge/access.ts'
import { ReplyQueue } from '../src/bridge/reply.ts'
import { PeerSessions } from '../src/bridge/session.ts'
import { PersonaStore } from '../src/persona/store.ts'
import type { ApiClient } from '../src/ilink/api.ts'

/** 记录投递消息的假会话。 */
function fakeSessions() {
  const delivered: { peerId: string; text: string }[] = []
  const sessions = {
    deliver: async (peerId: string, message: { content: { type: string; text?: string }[] }) => {
      delivered.push({ peerId, text: message.content.map(part => part.text ?? '').join('') })
    },
  }
  return { sessions: sessions as unknown as PeerSessions, delivered }
}

/** 可手动触发的事件源。 */
function fakeEvents() {
  let listener: ((session: { id: unknown }, event: unknown) => void) | undefined
  return {
    events: {
      on: (_event: 'session/event', next: (session: { id: unknown }, event: unknown) => void) => {
        listener = next
        return () => { listener = undefined }
      },
    },
    emit: (sessionId: string, event: unknown) => { listener?.({ id: sessionId }, event) },
  }
}

function userMessage(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 'm1',
    from_user_id: 'wxid-owner',
    message_type: 1,
    context_token: 'ctx-1',
    item_list: [{ type: 1, text_item: { text: '在吗' } }],
    ...overrides,
  }
}

describe('textOf', () => {
  it('拼接文本项，忽略未知类型', () => {
    assert.equal(textOf({ item_list: [{ type: 1, text_item: { text: 'a' } }, { type: 9 }] } as never), 'a')
  })

  it('语音优先用服务端转写', () => {
    assert.equal(textOf({ item_list: [{ type: 3, voice_item: { text: '语音内容' } }] } as never), '语音内容')
  })

  it('没有可读文本时返回空串', () => {
    assert.equal(textOf({ item_list: [{ type: 2 }] } as never), '')
  })
})

describe('Channel.handle', () => {
  function setup(options: { owner?: string; allow?: string } = {}) {
    const { sessions, delivered } = fakeSessions()
    const { events, emit } = fakeEvents()
    const sent: { peerId: string; text: string; token: string | undefined }[] = []
    const replies = new ReplyQueue({ send: async (peerId, text, token) => { sent.push({ peerId, text, token }) }, sleep: async () => {} })
    const channel = new Channel({
      api: {} as ApiClient,
      account: { baseUrl: 'https://x.cn', token: 't', userId: options.owner ?? 'wxid-owner' },
      sessions,
      access: createAccessPolicy({ allow: options.allow ?? '', owner: options.owner ?? 'wxid-owner' }),
      personas: new PersonaStore('/nonexistent-personas'),
      defaultPersona: 'default',
      replies,
      events,
      report: () => {},
      sleep: async () => {},
    })
    return { channel, delivered, sent, emit }
  }

  it('第一轮注入完整人设块', async () => {
    const { channel, delivered } = setup()
    await channel.handle(userMessage())
    assert.equal(delivered.length, 1)
    assert.match(delivered[0]?.text ?? '', /【角色设定/)
    assert.ok((delivered[0]?.text ?? '').endsWith('在吗'))
  })

  it('第二轮只带一行提醒', async () => {
    const { channel, delivered } = setup()
    await channel.handle(userMessage({ message_id: 'm1' }))
    await channel.handle(userMessage({ message_id: 'm2' }))
    assert.equal(delivered.length, 2)
    assert.doesNotMatch(delivered[1]?.text ?? '', /【角色设定/)
    assert.match(delivered[1]?.text ?? '', /继续扮演/)
  })

  it('重复的 message_id 只投递一次', async () => {
    const { channel, delivered } = setup()
    await channel.handle(userMessage({ message_id: 'dup' }))
    await channel.handle(userMessage({ message_id: 'dup' }))
    assert.equal(delivered.length, 1)
  })

  it('不在名单里的 peer 不投递也不回复', async () => {
    const { channel, delivered } = setup({ allow: 'someone-else' })
    await channel.handle(userMessage({ from_user_id: 'wxid-stranger' }))
    assert.equal(delivered.length, 0)
  })

  it('Bot 自己的消息被忽略', async () => {
    const { channel, delivered } = setup()
    await channel.handle(userMessage({ message_type: 2 }))
    assert.equal(delivered.length, 0)
  })

  it('形状不对的消息被忽略', async () => {
    const { channel, delivered } = setup()
    await channel.handle({ hello: 'world' })
    assert.equal(delivered.length, 0)
  })

  it('assistant/message 事件被发回对应 peer，并带上 context_token', async () => {
    const { channel, sent, emit } = setup()
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '在。说。' }] } },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(sent.length, 1)
    assert.equal(sent[0]?.text, '在。说。')
    assert.equal(sent[0]?.token, 'ctx-1')
  })

  it('工具消息（旁白）不发，未知会话不发', async () => {
    const { channel, sent, emit } = setup()
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '接下来：' }, { type: 'tool-call' }] } },
    })
    emit('some-other-session', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '不该发' }] } },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(sent.length, 0)
  })
})

describe('Channel.run', () => {
  it('保存游标，并在 stop 后退出', async () => {
    const { sessions, delivered } = fakeSessions()
    const { events } = fakeEvents()
    let polls = 0
    const channel = new Channel({
      api: {
        getUpdates: async (params: { cursor?: string }) => {
          polls += 1
          if (polls === 1) {
            assert.equal(params.cursor, undefined)
            return { msgs: [userMessage()], get_updates_buf: 'cursor-2', longpolling_timeout_ms: 35000 }
          }
          // 第二次轮询时停掉自己：模拟宿主关闭。
          await channel.stop()
          throw new Error('aborted')
        },
      } as unknown as ApiClient,
      account: { baseUrl: 'https://x.cn', token: 't', userId: 'wxid-owner' },
      sessions,
      access: createAccessPolicy({ owner: 'wxid-owner' }),
      personas: new PersonaStore('/nonexistent-personas'),
      defaultPersona: 'default',
      replies: new ReplyQueue({ send: async () => {}, sleep: async () => {} }),
      events,
      report: () => {},
      sleep: async () => {},
    })
    await channel.run()
    assert.equal(delivered.length, 1)
    assert.equal(channel.getCursor(), 'cursor-2')
    assert.equal(polls, 2)
  })
})
