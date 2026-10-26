/**
 * 通道运行时的测试：假 api、假会话、真 ReplyQueue。
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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


describe('Channel 与 per-chat 设置', () => {
  it('被关掉的聊天不投递', async () => {
    const { sessions, delivered } = fakeSessions()
    const { events } = fakeEvents()
    const channel = new Channel({
      api: {} as ApiClient,
      account: { baseUrl: 'https://x.cn', token: 't', userId: 'wxid-owner' },
      sessions,
      access: createAccessPolicy({ owner: 'wxid-owner' }),
      personas: new PersonaStore('/nonexistent'),
      defaultPersona: 'default',
      replies: new ReplyQueue({ send: async () => {}, sleep: async () => {} }),
      events,
      report: () => {},
      sleep: async () => {},
      settings: { get: async () => ({ enabled: false, proactive: false }) } as never,
    })
    await channel.handle(userMessage())
    assert.equal(delivered.length, 0)
  })

  it('聊天指定的 personaId 会被使用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-personas-'))
    await mkdir(join(root, 'xiao-jing'), { recursive: true })
    await writeFile(join(root, 'xiao-jing', 'persona.json'), JSON.stringify({
      id: 'xiao-jing',
      name: '小鲸',
      prompt: { identity: '你是{{name}}，说话很短。' },
    }), 'utf8')

    const { sessions, delivered } = fakeSessions()
    const { events } = fakeEvents()
    const channel = new Channel({
      api: {} as ApiClient,
      account: { baseUrl: 'https://x.cn', token: 't', userId: 'wxid-owner' },
      sessions,
      access: createAccessPolicy({ owner: 'wxid-owner' }),
      personas: new PersonaStore(root),
      defaultPersona: 'default',
      replies: new ReplyQueue({ send: async () => {}, sleep: async () => {} }),
      events,
      report: () => {},
      sleep: async () => {},
      settings: { get: async () => ({ enabled: true, proactive: false, personaId: 'xiao-jing' }) } as never,
    })
    await channel.handle(userMessage())
    assert.match(delivered[0]?.text ?? '', /小鲸/)
  })

  it('聊天的 maxChars 会限制单条长度', async () => {
    const { sessions, delivered } = fakeSessions()
    const { events, emit } = fakeEvents()
    const sent: string[] = []
    const channel = new Channel({
      api: {} as ApiClient,
      account: { baseUrl: 'https://x.cn', token: 't', userId: 'wxid-owner' },
      sessions,
      access: createAccessPolicy({ owner: 'wxid-owner' }),
      personas: new PersonaStore('/nonexistent'),
      defaultPersona: 'default',
      replies: new ReplyQueue({ send: async (_peer, text) => { sent.push(text) }, sleep: async () => {} }),
      events,
      report: () => {},
      sleep: async () => {},
      settings: { get: async () => ({ enabled: true, proactive: false, maxChars: 30 }) } as never,
    })
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '第一段'.repeat(20) + '\n\n' + '第二段'.repeat(20) }] } },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(sent.length > 1, `应被拆成多条，实际 ${String(sent.length)} 条`)
    for (const text of sent) assert.ok(text.length <= 30, `单条超限：${String(text.length)}`)
    assert.equal(delivered.length, 1)
  })
})


describe('主动搭话', () => {
  async function personaRoot(proactiveEnabled: boolean): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'proactive-personas-'))
    await mkdir(join(root, 'chatty'), { recursive: true })
    await writeFile(join(root, 'chatty', 'persona.json'), JSON.stringify({
      id: 'chatty',
      name: '话痨',
      prompt: { identity: '你是{{name}}，爱主动开口。' },
      proactive: { enabled: proactiveEnabled, minIdleHours: 1, quietHours: ['23:00', '08:00'] },
    }), 'utf8')
    return root
  }

  function makeChannel(options: { personas: PersonaStore; settings: unknown; now: number }) {
    const { sessions, delivered } = fakeSessions()
    const { events } = fakeEvents()
    const channel = new Channel({
      api: {} as ApiClient,
      account: { baseUrl: 'https://x.cn', token: 't', userId: 'wxid-owner' },
      sessions,
      access: createAccessPolicy({ owner: 'wxid-owner' }),
      personas: options.personas,
      defaultPersona: 'chatty',
      replies: new ReplyQueue({ send: async () => {}, sleep: async () => {} }),
      events,
      report: () => {},
      sleep: async () => {},
      now: () => options.now,
      settings: options.settings as never,
    })
    return { channel, delivered }
  }

  it('空闲够久且允许时，主动发起一轮', async () => {
    const now = Date.parse('2026-10-26T14:00:00+08:00')
    const root = await personaRoot(true)
    const { channel } = makeChannel({
      personas: new PersonaStore(root),
      settings: { get: async () => ({ enabled: true, proactive: true }) },
      now,
    })
    // 先让它有一次活动记录（2 小时前）。
    ;(channel as unknown as { lastActivity: Map<string, number> }).lastActivity.set('wxid-owner', now - 2 * 60 * 60 * 1_000)
    const poked = await channel.poke('wxid-owner')
    assert.equal(poked, true)
  })

  it('刚说完话不主动', async () => {
    const now = Date.parse('2026-10-26T14:00:00+08:00')
    const { channel } = makeChannel({
      personas: new PersonaStore(await personaRoot(true)),
      settings: { get: async () => ({ enabled: true, proactive: true }) },
      now,
    })
    ;(channel as unknown as { lastActivity: Map<string, number> }).lastActivity.set('wxid-owner', now - 60_000)
    assert.equal(await channel.poke('wxid-owner'), false)
  })

  it('聊天没开主动时不主动', async () => {
    const now = Date.parse('2026-10-26T14:00:00+08:00')
    const { channel } = makeChannel({
      personas: new PersonaStore(await personaRoot(true)),
      settings: { get: async () => ({ enabled: true, proactive: false }) },
      now,
    })
    ;(channel as unknown as { lastActivity: Map<string, number> }).lastActivity.set('wxid-owner', now - 5 * 60 * 60 * 1_000)
    assert.equal(await channel.poke('wxid-owner'), false)
  })

  it('人格卡没开主动时不主动', async () => {
    const now = Date.parse('2026-10-26T14:00:00+08:00')
    const { channel } = makeChannel({
      personas: new PersonaStore(await personaRoot(false)),
      settings: { get: async () => ({ enabled: true, proactive: true }) },
      now,
    })
    ;(channel as unknown as { lastActivity: Map<string, number> }).lastActivity.set('wxid-owner', now - 5 * 60 * 60 * 1_000)
    assert.equal(await channel.poke('wxid-owner'), false)
  })
})
