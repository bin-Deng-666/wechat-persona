/**
 * 通道运行时的测试：假 api、假会话、真 ReplyQueue。
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { Channel, textOf } from '../../src/wechat/channel.ts'
import { createAccessPolicy } from '../../src/wechat/access.ts'
import { ReplyQueue } from '../../src/reply/queue.ts'
import { PeerSessions } from '../../src/dsh/sessions.ts'
import { PersonaStore } from '../../src/persona/store.ts'
import { ChatSettingsStore } from '../../src/chat/settings.ts'
import { PeerGenerations } from '../../src/chat/generations.ts'
import type { ApiClient } from '../../src/ilink/api.ts'

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
      mergeWindowMs: 0,
    })
    return { channel, delivered, sent, emit }
  }

  it('第一轮只投递微信原文', async () => {
    const { channel, delivered } = setup()
    await channel.handle(userMessage())
    assert.deepEqual(delivered, [{ peerId: 'wxid-owner', text: '在吗' }])
  })

  it('后续轮次也不混入人设提醒', async () => {
    const { channel, delivered } = setup()
    await channel.handle(userMessage({ message_id: 'm1' }))
    await channel.handle(userMessage({ message_id: 'm2' }))
    assert.deepEqual(delivered.map(item => item.text), ['在吗', '在吗'])
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

  it('工具旁白作为真实过程发送，未知会话仍忽略', async () => {
    const { channel, sent, emit } = setup()
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: '不能公开' }, { type: 'text', text: '接下来核对配置。' }, { type: 'tool-call' }] } },
    })
    emit('some-other-session', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '不该发' }] } },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(sent.map(item => item.text), ['接下来核对配置。'])
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
          await channel.whenIdle()
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
      mergeWindowMs: 0,
    })
    await channel.run()
    assert.equal(delivered.length, 1)
    assert.equal(channel.getCursor(), 'cursor-2')
    assert.equal(polls, 2)
  })

  it('主动切断的长轮询不算故障，不触发退避也不报错', async () => {
    const { sessions } = fakeSessions()
    const { events } = fakeEvents()
    const reports: string[] = []
    let polls = 0
    const channel = new Channel({
      api: {
        getUpdates: async () => {
          polls += 1
          if (polls < 3) {
            // 模拟「我们 4 秒切断」：分类是 timeout，而不是服务端拒绝。
            throw Object.assign(new Error('getupdates: 请求超时'), { classification: { type: 'timeout', description: '请求超时' } })
          }
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
      report: line => { reports.push(line) },
      sleep: async () => { throw new Error('不该睡：超时后应立刻重问') },
      mergeWindowMs: 0,
    })
    await channel.run()
    assert.equal(polls, 3)
    assert.deepEqual(reports.filter(line => line.includes('轮询失败')), [])
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
      mergeWindowMs: 0,
      settings: { get: async () => ({ enabled: false }) } as never,
    })
    await channel.handle(userMessage())
    assert.equal(delivered.length, 0)
  })

  it('聊天指定的 personaId 会被使用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-personas-'))
    await mkdir(join(root, 'jarvis'), { recursive: true })
    await writeFile(join(root, 'jarvis', 'persona.json'), JSON.stringify({
      id: 'jarvis',
      name: '贾维斯',
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
      mergeWindowMs: 0,
      settings: { get: async () => ({ enabled: true, personaId: 'jarvis' }) } as never,
    })
    await channel.handle(userMessage())
    assert.equal(delivered[0]?.text, '在吗')
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
      mergeWindowMs: 0,
      settings: { get: async () => ({ enabled: true, maxChars: 30 }) } as never,
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


describe('回复里的表情标记', () => {
  function channelWithSticker(sendSticker: (peer: string, name: string) => Promise<boolean>) {
    const { sessions } = fakeSessions()
    const { events, emit } = fakeEvents()
    const sent: string[] = []
    const channel = new Channel({
      api: {} as ApiClient,
      account: { baseUrl: 'https://x.cn', token: 't', userId: 'wxid-owner' },
      sessions,
      access: createAccessPolicy({ owner: 'wxid-owner' }),
      personas: new PersonaStore('/nonexistent'),
      defaultPersona: 'default',
      replies: new ReplyQueue({ send: async (_peer, text) => { sent.push(text) }, sendSticker, sleep: async () => {} }),
      events,
      report: () => {},
      sleep: async () => {},
      mergeWindowMs: 0,
    })
    return { channel, emit, sent }
  }

  const reply = (text: string) => ({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  })

  it('表情发成功时，只把剩余文字发出去', async () => {
    const names: string[] = []
    const { channel, emit, sent } = channelWithSticker(async (_peer, name) => { names.push(name); return true })
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', reply('好啊 [表情:开心]'))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(names, ['开心'])
    assert.deepEqual(sent, ['好啊'])
  })

  it('表情发失败时退回纯文字（不留标记）', async () => {
    const { channel, emit, sent } = channelWithSticker(async () => false)
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', reply('[表情:没有这张] 算了'))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(sent, ['算了'])
  })

  it('只有表情、没有文字时，成功后不再发空消息', async () => {
    const { channel, emit, sent } = channelWithSticker(async () => true)
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', reply('[表情:开心]'))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(sent, [])
  })
})


describe('输入状态', () => {
  it('收到消息时开始上报「正在输入」', async () => {
    const { sessions } = fakeSessions()
    const { events } = fakeEvents()
    const started: { peerId: string; token: string | undefined }[] = []
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
      mergeWindowMs: 0,
      typing: {
        start: async (peerId, token) => { started.push({ peerId, token }) },
        stop: async () => {},
      },
    })
    await channel.handle(userMessage())
    assert.deepEqual(started, [{ peerId: 'wxid-owner', token: 'ctx-1' }])
  })
})


describe('内置命令', () => {
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'cmd-personas-'))
    await mkdir(join(root, 'alpha'), { recursive: true })
    await writeFile(join(root, 'alpha', 'persona.json'), JSON.stringify({ id: 'alpha', name: '甲', prompt: { identity: '你是甲。' } }), 'utf8')
    await mkdir(join(root, 'beta'), { recursive: true })
    await writeFile(join(root, 'beta', 'persona.json'), JSON.stringify({ id: 'beta', name: '乙', prompt: { identity: '你是乙。' } }), 'utf8')

    const delivered: { peerId: string; text: string; generation: number }[] = []
    const sessions = {
      deliver: async (peerId: string, message: { content: { type: string; text?: string }[] }, generation?: number) => {
        delivered.push({ peerId, text: message.content.map(p => p.text ?? '').join(''), generation: generation ?? 0 })
      },
    }
    const { events } = fakeEvents()
    const sent: string[] = []
    const settings = new ChatSettingsStore(join(root, 'chats'))
    const generations = new PeerGenerations(join(root, 'generations.json'))
    const channel = new Channel({
      api: {} as ApiClient,
      account: { baseUrl: 'https://x.cn', token: 't', userId: 'wxid-owner' },
      sessions: sessions as unknown as PeerSessions,
      access: createAccessPolicy({ owner: 'wxid-owner' }),
      personas: new PersonaStore(root),
      defaultPersona: 'alpha',
      replies: new ReplyQueue({ send: async (_peer, text) => { sent.push(text) }, sleep: async () => {} }),
      events,
      report: () => {},
      sleep: async () => {},
      mergeWindowMs: 0,
      settings,
      generations,
      permissionLabel: 'danger-full-access',
    })
    return { channel, delivered, sent, settings, generations }
  }

  it('/help 只回复，不投给模型', async () => {
    const { channel, delivered, sent } = await setup()
    await channel.handle(userMessage({ item_list: [{ type: 1, text_item: { text: '/help' } }] }))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(delivered.length, 0)
    assert.match(sent[0] ?? '', /设置 · 打开聊天设置/)
  })

  it('设置打开菜单，回复数字就是选项', async () => {
    const { channel, delivered, sent, settings } = await setup()
    await channel.handle(userMessage({ message_id: 'm0', item_list: [{ type: 1, text_item: { text: '设置' } }] }))
    assert.match(sent[0] ?? '', /1 {2}换人格/)
    assert.match(sent[0] ?? '', /当前人格：甲/)
    await channel.handle(userMessage({ message_id: 'm1', item_list: [{ type: 1, text_item: { text: '1' } }] }))
    assert.match(sent[1] ?? '', /切换人格/)
    await channel.handle(userMessage({ message_id: 'm2', item_list: [{ type: 1, text_item: { text: '2' } }] }))
    assert.match(sent[2] ?? '', /已切到「乙」/)
    assert.equal((await settings.get('wxid-owner')).personaId, 'beta')
    assert.equal(delivered.length, 0)
  })

  it('菜单里说别的事就收起菜单，不吞消息', async () => {
    const { channel, delivered } = await setup()
    await channel.handle(userMessage({ message_id: 'x0', item_list: [{ type: 1, text_item: { text: '设置' } }] }))
    await channel.handle(userMessage({ message_id: 'x1', item_list: [{ type: 1, text_item: { text: '3 点开会' } }] }))
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0]?.text, '3 点开会')
  })

  it('/new 之后的消息用新代次', async () => {
    const { channel, delivered, sent, generations } = await setup()
    await channel.handle(userMessage({ message_id: 'c1', item_list: [{ type: 1, text_item: { text: '/new' } }] }))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.match(sent[0] ?? '', /已开新对话/)
    assert.equal(await generations.get('wxid-owner'), 1)

    await channel.handle(userMessage({ message_id: 'c2', item_list: [{ type: 1, text_item: { text: '你好' } }] }))
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0]?.generation, 1)
    assert.equal(delivered[0]?.text, '你好')
  })

  it('/status 报人格与段数', async () => {
    const { channel, sent } = await setup()
    await channel.handle(userMessage({ item_list: [{ type: 1, text_item: { text: '/status' } }] }))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.match(sent[0] ?? '', /甲（alpha）/)
    assert.match(sent[0] ?? '', /danger-full-access/)
  })

  it('/persona 列出可选人格', async () => {
    const { channel, sent } = await setup()
    await channel.handle(userMessage({ item_list: [{ type: 1, text_item: { text: '/persona' } }] }))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.match(sent[0] ?? '', /1 {2}甲  ✓ 当前使用/)
    assert.match(sent[0] ?? '', /2 {2}乙/)
  })

  it('/persona <id> 切换并持久化', async () => {
    const { channel, sent, settings } = await setup()
    await channel.handle(userMessage({ message_id: 'p1', item_list: [{ type: 1, text_item: { text: '/persona beta' } }] }))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.match(sent[0] ?? '', /已切到「乙」/)
    assert.equal((await settings.get('wxid-owner')).personaId, 'beta')
  })

  it('/persona 给不存在的 id 时不改设置', async () => {
    const { channel, sent, settings } = await setup()
    await channel.handle(userMessage({ message_id: 'p2', item_list: [{ type: 1, text_item: { text: '/persona nope' } }] }))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.match(sent[0] ?? '', /没有「nope」/)
    assert.equal((await settings.get('wxid-owner')).personaId, undefined)
  })

  it('未知命令回复提示', async () => {
    const { channel, delivered, sent } = await setup()
    await channel.handle(userMessage({ item_list: [{ type: 1, text_item: { text: '/whatever' } }] }))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(delivered.length, 0)
    assert.match(sent[0] ?? '', /没有 \/whatever/)
  })
})

describe('连发合并与失败反馈', () => {
  function setup(options: { mergeWindowMs?: number } = {}) {
    const { sessions, delivered } = fakeSessions()
    const { events, emit } = fakeEvents()
    const sent: { peerId: string; text: string; token: string | undefined }[] = []
    const replies = new ReplyQueue({
      send: async (peerId, text, token) => { sent.push({ peerId, text, token }) },
      sleep: async () => {},
    })
    const channel = new Channel({
      api: {} as ApiClient,
      account: { baseUrl: 'https://x.cn', token: 't', userId: 'wxid-owner' },
      sessions,
      access: createAccessPolicy({ owner: 'wxid-owner' }),
      personas: new PersonaStore('/nonexistent'),
      defaultPersona: 'default',
      replies,
      events,
      report: () => {},
      sleep: async () => {},
      mergeWindowMs: options.mergeWindowMs ?? 0,
      // 测试里不要真的等 25 秒。
          })
    return { channel, delivered, sent, emit }
  }

  it('同一窗口里的几条消息合成一轮', async () => {
    const { channel, delivered } = setup({ mergeWindowMs: 30 })
    await channel.handle(userMessage({ message_id: 'm1', item_list: [{ type: 1, text_item: { text: '在吗' } }] }))
    await channel.handle(userMessage({ message_id: 'm2', item_list: [{ type: 1, text_item: { text: '帮我看看桌面' } }] }))
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(delivered.length, 1, '两条消息应该只开一轮')
    assert.match(delivered[0]?.text ?? '', /在吗/)
    assert.match(delivered[0]?.text ?? '', /帮我看看桌面/)
  })

  it('窗口外的消息各成一轮', async () => {
    const { channel, delivered } = setup({ mergeWindowMs: 10 })
    await channel.handle(userMessage({ message_id: 'm1' }))
    await new Promise(resolve => setTimeout(resolve, 50))
    await channel.handle(userMessage({ message_id: 'm2' }))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(delivered.length, 2)
  })

  it('一轮失败时回一句原因', async () => {
    const { channel, sent, emit } = setup()
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', {
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: '模型返回了 400' } } },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(sent.some(item => item.text.includes('模型或服务暂时出错了') && item.text.includes('模型返回了 400')), JSON.stringify(sent))
  })

  it('被前置条件挡下时说清楚（这不是等审批）', async () => {
    const { channel, sent, emit } = setup()
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', { type: 'turn/end', data: { reason: { kind: 'blocked' } } })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(sent.some(item => item.text.includes('暂时无法继续')))
  })

  it('长度截断时说清楚，而不是沉默', async () => {
    const { channel, sent, emit } = setup()
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(sent.some(item => item.text.includes('长度上限')))
  })

  it('没有旁白的工具步骤不虚构任务详情', async () => {
    const { channel, sent, emit } = setup()
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', { type: 'turn/start', data: { turn: 1 } })
    // 只跑工具、不说话：中间不产出任何消息。
    emit('channel-persona-wxid-owner', {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'tool-call', name: 'bash' }] } },
    })
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(sent.length, 0)
    // 正文到达后才有一条。
    emit('channel-persona-wxid-owner', {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '做完了。' }] } },
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.deepEqual(sent.map(item => item.text), ['做完了。'])
  })

  it('正常结束且有正文时不多嘴', async () => {
    const { channel, sent, emit } = setup()
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '好了。' }] } },
    })
    emit('channel-persona-wxid-owner', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(sent.map(item => item.text), ['好了。'])
  })

  it('正常结束却没有任何正文时明确告知，不静默', async () => {
    const { channel, sent, emit } = setup()
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(sent.some(item => item.text.includes('没有生成可发送的回复')), JSON.stringify(sent))
  })
})

describe('交付文件', () => {
  it('present 的文件会发到微信，相对路径按会话 cwd 补全', async () => {
    const { sessions } = fakeSessions()
    const { events, emit } = fakeEvents()
    const sentFiles: { peerId: string; paths: readonly string[]; token: string | undefined }[] = []
    const channel = new Channel({
      api: {} as ApiClient,
      account: { baseUrl: 'https://x.cn', token: 't', userId: 'wxid-owner' },
      sessions,
      access: createAccessPolicy({ owner: 'wxid-owner' }),
      personas: new PersonaStore('/nonexistent'),
      defaultPersona: 'default',
      replies: new ReplyQueue({ send: async () => {}, sleep: async () => {}, sendFile: async (peerId, path, token) => { sentFiles.push({ peerId, paths: [path], token }) } }),
      events, mergeWindowMs: 0, cwd: '/work',
    })
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', {
      type: 'deliverables/presented',
      data: { files: [{ path: 'out/报告.docx' }, { path: '/abs/表格.xlsx' }, { nope: 1 }] },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(sentFiles.length, 2)
    assert.deepEqual(sentFiles.flatMap(item => item.paths), ['/work/out/报告.docx', '/abs/表格.xlsx'])
    assert.equal(sentFiles[0]?.token, 'ctx-1')
  })

  it('发送失败时回一句原因，而不是静默', async () => {
    const { sessions } = fakeSessions()
    const { events, emit } = fakeEvents()
    const sent: string[] = []
    const channel = new Channel({
      api: {} as ApiClient,
      account: { baseUrl: 'https://x.cn', token: 't', userId: 'wxid-owner' },
      sessions,
      access: createAccessPolicy({ owner: 'wxid-owner' }),
      personas: new PersonaStore('/nonexistent'),
      defaultPersona: 'default',
      replies: new ReplyQueue({ send: async (_peer, text) => { sent.push(text) }, sendFile: async () => { throw new Error('文件太大') }, sleep: async () => {} }),
      events,
      report: () => {},
      sleep: async () => {},
      mergeWindowMs: 0,
    })
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', { type: 'deliverables/presented', data: { files: [{ path: '/a.docx' }] } })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(sent.some(text => text.includes('文件未确认发出')), JSON.stringify(sent))
  })
})

describe('记忆标记', () => {
  it('旧版标记不泄露到微信，也不能绕过来源校验写入记忆', async () => {
    const { sessions } = fakeSessions()
    const { events, emit } = fakeEvents()
    const sent: string[] = []
    const remembered: string[][] = []
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
      mergeWindowMs: 0,
      memory: {
        lineFor: () => undefined,
        get: () => [],
        remember: async (_peer: string, facts: readonly string[]) => { remembered.push([...facts]); return facts.length },
        clear: async () => {},
      } as never,
    })
    await channel.handle(userMessage({ message_id: 'm1' }))
    emit('channel-persona-wxid-owner', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '记下了。[记住: 用户偏好简洁回答]' }] } },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(sent, ['记下了。'])
    assert.deepEqual(remembered, [])
  })
})

describe('卡住与连续入站', () => {
  function setup(options: { mergeWindowMs?: number; stallAfterMs?: number; now?: () => number } = {}) {
    const { sessions, delivered } = fakeSessions()
    const { events, emit } = fakeEvents()
    const sent: { peerId: string; text: string; token: string | undefined }[] = []
    const reports: { line: string; detail?: unknown }[] = []
    const replies = new ReplyQueue({ send: async (peerId, text, token) => { sent.push({ peerId, text, token }) }, sleep: async () => {} })
    const channel = new Channel({
      api: {} as ApiClient,
      account: { baseUrl: 'https://x.cn', token: 't', userId: 'wxid-owner' },
      sessions,
      access: createAccessPolicy({ owner: 'wxid-owner' }),
      personas: new PersonaStore('/nonexistent'),
      defaultPersona: 'default',
      replies,
      events,
      report: (line, detail) => { reports.push({ line, detail }) },
      sleep: async () => {},
      mergeWindowMs: options.mergeWindowMs ?? 0,
            stallAfterMs: options.stallAfterMs ?? 0,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    return { channel, delivered, sent, emit, reports }
  }

  it('单条长耗时：过程中保持沉默，正文到达后只发一次', async () => {
    const { channel, sent, emit } = setup()
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', { type: 'turn/start', data: { turn: 1 } })
    // 连续多个工具步骤，中间不产出任何内容。
    for (let step = 0; step < 3; step += 1) {
      emit('channel-persona-wxid-owner', {
        type: 'assistant/message',
        data: { turn: 1, message: { content: [{ type: 'tool-call', name: 'bash' }] } },
      })
    }
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(sent.length, 0, `等待期间不该有输出：${JSON.stringify(sent.map((item: { text: string }) => item.text))}`)
    emit('channel-persona-wxid-owner', {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '跑完了，结果是这样。' }] } },
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.deepEqual(sent.map(item => item.text), ['跑完了，结果是这样。'])
  })

  it('连着发几条：第二轮正文不会被当成过期内容丢掉', async () => {
    const { channel, sent, emit } = setup()
    await channel.handle(userMessage({ message_id: 'a', item_list: [{ type: 1, text_item: { text: '看看日志' } }] }))
    emit('channel-persona-wxid-owner', { type: 'turn/start', data: { turn: 1 } })
    emit('channel-persona-wxid-owner', {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '第一轮的回答。' }] } },
    })
    // 用户在模型还没收工时又发了一条。
    await channel.handle(userMessage({ message_id: 'b', item_list: [{ type: 1, text_item: { text: '怎么样了' } }] }))
    emit('channel-persona-wxid-owner', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    emit('channel-persona-wxid-owner', { type: 'turn/start', data: { turn: 2 } })
    emit('channel-persona-wxid-owner', {
      type: 'assistant/message',
      data: { turn: 2, message: { content: [{ type: 'text', text: '第二轮的回答。' }] } },
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    const texts = sent.map(item => item.text)
    assert.ok(texts.some(text => text.includes('第一轮的回答')), JSON.stringify(texts))
    assert.ok(texts.some(text => text.includes('第二轮的回答')), `第二轮被丢掉了：${JSON.stringify(texts)}`)
  })


  it('长任务期间来了新消息，后续进展用最新令牌发送', async () => {
    const { channel, sent, emit } = setup()
    await channel.handle(userMessage({ message_id: 'a', context_token: 'old-token' }))
    emit('channel-persona-wxid-owner', { type: 'turn/start', data: { turn: 1 } })
    // 模型还在跑时，用户又发了一条：这条带来新的 context_token。
    await channel.handle(userMessage({ message_id: 'b', context_token: 'fresh-token', item_list: [{ type: 1, text_item: { text: '还在吗' } }] }))
    emit('channel-persona-wxid-owner', { type: 'turn/start', data: { turn: 2 } })
    emit('channel-persona-wxid-owner', {
      type: 'assistant/message',
      data: { turn: 2, message: { content: [{ type: 'text', text: '接下来核对配置。' }, { type: 'tool-call', name: 'bash' }] } },
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    const progress = sent.find(item => item.text.includes('接下来核对配置'))
    assert.equal(progress?.token, 'fresh-token', JSON.stringify(sent))
  })

  it('回合结束时清空待认领集合，不靠额外的 user/message', async () => {
    const { channel, sent, emit } = setup()
    await channel.handle(userMessage({ message_id: 'a' }))
    emit('channel-persona-wxid-owner', { type: 'turn/start', data: { turn: 1 } })
    // 第二条在运行中到达，进入待认领。
    await channel.handle(userMessage({ message_id: 'b', item_list: [{ type: 1, text_item: { text: '再加一句' } }] }))
    emit('channel-persona-wxid-owner', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    emit('channel-persona-wxid-owner', { type: 'turn/start', data: { turn: 2 } })
    emit('channel-persona-wxid-owner', {
      type: 'assistant/message',
      data: { turn: 2, message: { content: [{ type: 'text', text: '这一轮有内容。' }] } },
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.ok(sent.some(item => item.text.includes('这一轮有内容')), JSON.stringify(sent))
  })

  it('交给宿主后一直没有开轮，会主动说一声而不是无声挂着', async () => {
    const { channel, sent } = setup({ stallAfterMs: 40 })
    await channel.handle(userMessage())
    await new Promise(resolve => setTimeout(resolve, 90))
    assert.ok(sent.some(item => item.text.includes('还没轮到模型处理')), JSON.stringify(sent))
  })

  it('开轮之后卡住，措辞是「跑得比较久」而不是「排了很久」', async () => {
    const { channel, sent, emit } = setup({ stallAfterMs: 40 })
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', { type: 'turn/start', data: { turn: 1 } })
    await new Promise(resolve => setTimeout(resolve, 90))
    // 开轮即解除「排队」计时；这里验证的是不会误报排队文案。
    assert.deepEqual(sent.filter(item => item.text.includes('还没轮到模型处理')), [])
  })

  it('分段计时写进日志，能算出排队与首字耗时', async () => {
    let clock = 1_000
    const { channel, emit, reports } = setup({ now: () => clock })
    await channel.handle(userMessage())
    clock = 1_400
    emit('channel-persona-wxid-owner', { type: 'turn/start', data: { turn: 1 } })
    clock = 3_400
    emit('channel-persona-wxid-owner', {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '好了' }] } },
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    const legs = reports.filter(item => item.line.startsWith('时序'))
    assert.ok(legs.some(item => item.line === '时序 submitted'), JSON.stringify(legs))
    assert.ok(legs.some(item => item.line === '时序 turn-start'), JSON.stringify(legs))
    assert.ok(legs.some(item => item.line === '时序 first-text'), JSON.stringify(legs))
    const firstText = legs.find(item => item.line === '时序 first-text')
    assert.equal((firstText?.detail as { sinceReceived?: number } | undefined)?.sinceReceived, 2_400)
  })
})

describe('报平安', () => {
  function setup(options: { noticeIntervalMs?: number; personaRoot?: string; personaId?: string } = {}) {
    const { sessions, delivered } = fakeSessions()
    const { events, emit } = fakeEvents()
    const sent: { peerId: string; text: string; token: string | undefined }[] = []
    const reports: { line: string; detail?: unknown }[] = []
    const replies = new ReplyQueue({ send: async (peerId, text, token) => { sent.push({ peerId, text, token }) }, sleep: async () => {} })
    const channel = new Channel({
      api: {} as ApiClient,
      account: { baseUrl: 'https://x.cn', token: 't', userId: 'wxid-owner' },
      sessions,
      access: createAccessPolicy({ owner: 'wxid-owner' }),
      personas: new PersonaStore(options.personaRoot ?? '/nonexistent'),
      defaultPersona: options.personaId ?? 'default',
      replies,
      events,
      report: (line, detail) => { reports.push({ line, detail }) },
      sleep: async () => {},
      mergeWindowMs: 0,
      stallAfterMs: 0,
      noticeIntervalMs: options.noticeIntervalMs ?? 30,
    })
    return { channel, delivered, sent, emit, reports }
  }

  const textStep = (turn: number, text: string) => ({
    type: 'assistant/message',
    data: { turn, message: { content: [{ type: 'text', text }] } },
  })

  it('任务进行中按间隔报平安', async () => {
    const { channel, sent } = setup({ noticeIntervalMs: 30 })
    await channel.handle(userMessage())
    await new Promise(resolve => setTimeout(resolve, 110))
    const names = sent.map(item => item.text)
    assert.ok(names.length >= 2, `应当至少报两次：${JSON.stringify(names)}`)
    assert.ok(names.length <= 5, `不应刷屏：${JSON.stringify(names)}`)
    await channel.stop()
  })

  it('一轮之内不重复', async () => {
    const { channel, sent } = setup({ noticeIntervalMs: 20 })
    await channel.handle(userMessage())
    await new Promise(resolve => setTimeout(resolve, 160))
    const names = sent.map(item => item.text)
    assert.ok(names.length >= 3, `样本太少：${JSON.stringify(names)}`)
    assert.equal(new Set(names).size, names.length, `出现重复：${JSON.stringify(names)}`)
    await channel.stop()
  })

  it('快速完成不发报平安', async () => {
    const { channel, sent, emit } = setup({ noticeIntervalMs: 5_000 })
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', { type: 'turn/start', data: { turn: 1 } })
    emit('channel-persona-wxid-owner', textStep(1, '好了。'))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.deepEqual(sent.map(item => item.text), ['好了。'])
    await channel.stop()
  })

  it('正文到达后立刻停，不再补报平安', async () => {
    const { channel, sent, emit } = setup({ noticeIntervalMs: 25 })
    await channel.handle(userMessage())
    await new Promise(resolve => setTimeout(resolve, 80))
    const before = sent.length
    assert.ok(before >= 1)
    emit('channel-persona-wxid-owner', { type: 'turn/start', data: { turn: 1 } })
    emit('channel-persona-wxid-owner', textStep(1, '做完了。'))
    await new Promise(resolve => setTimeout(resolve, 100))
    const after = sent.map(item => item.text)
    assert.ok(after.includes('做完了。'), JSON.stringify(after))
    // 正文之后不应再有新的报平安。
    assert.equal(after.filter(text => text !== '做完了。').length, before, JSON.stringify(after))
    await channel.stop()
  })

  it('连续入站合并到同一活动，报平安仍不重复', async () => {
    const { channel, sent } = setup({ noticeIntervalMs: 25 })
    await channel.handle(userMessage({ message_id: 'a' }))
    await new Promise(resolve => setTimeout(resolve, 40))
    await channel.handle(userMessage({ message_id: 'b', item_list: [{ type: 1, text_item: { text: '卡住了吗' } }] }))
    await channel.handle(userMessage({ message_id: 'c', item_list: [{ type: 1, text_item: { text: '什么情况' } }] }))
    await new Promise(resolve => setTimeout(resolve, 110))
    const names = sent.map(item => item.text)
    assert.ok(names.length >= 2, `应当继续报平安：${JSON.stringify(names)}`)
    assert.equal(new Set(names).size, names.length, `出现重复：${JSON.stringify(names)}`)
    await channel.stop()
  })

  it('用当前人格卡里的句子，而不是内置库', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wechat-notice-'))
    await mkdir(join(root, 'tester'), { recursive: true })
    await writeFile(join(root, 'tester', 'persona.json'), JSON.stringify({
      id: 'tester', name: '测试', prompt: { identity: '你是测试。' },
      progress: [
        '甲句在此', '乙句在此', '丙句在此', '丁句在此', '戊句在此',
        '己句在此', '庚句在此', '辛句在此', '壬句在此', '癸句在此',
      ],
    }), 'utf8')
    const { channel, sent } = setup({ noticeIntervalMs: 20, personaRoot: root, personaId: 'tester' })
    await channel.handle(userMessage())
    await new Promise(resolve => setTimeout(resolve, 80))
    const names = sent.map(item => item.text)
    assert.ok(names.length >= 1, JSON.stringify(names))
    for (const text of names) assert.match(text, /句在此/u, `用了内置库：${JSON.stringify(names)}`)
    await channel.stop()
    await rm(root, { force: true, recursive: true })
  })

  it('人格卡没有该字段时回退内置库', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wechat-notice-bare-'))
    await mkdir(join(root, 'bare'), { recursive: true })
    await writeFile(join(root, 'bare', 'persona.json'), JSON.stringify({
      id: 'bare', name: '裸卡', prompt: { identity: '你是裸卡。' },
    }), 'utf8')
    const { channel, sent } = setup({ noticeIntervalMs: 20, personaRoot: root, personaId: 'bare' })
    await channel.handle(userMessage())
    await new Promise(resolve => setTimeout(resolve, 80))
    const names = sent.map(item => item.text)
    assert.ok(names.length >= 1, JSON.stringify(names))
    assert.doesNotMatch(names.join('\n'), /句在此/u)
    await channel.stop()
    await rm(root, { force: true, recursive: true })
  })
})
