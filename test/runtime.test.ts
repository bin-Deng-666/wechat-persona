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
import { ChatSettingsStore } from '../src/persona/settings.ts'
import { PeerGenerations } from '../src/bridge/generations.ts'
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
      mergeWindowMs: 0,
      settings: { get: async () => ({ enabled: true, personaId: 'xiao-jing' }) } as never,
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
      sendSticker,
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
    assert.match(sent[0] ?? '', /可用命令/)
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
    assert.match(sent[0] ?? '', /alpha 甲/)
    assert.match(sent[0] ?? '', /beta 乙/)
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
  function setup(options: { mergeWindowMs?: number; progressAfterMs?: number } = {}) {
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
      progressAfterMs: options.progressAfterMs ?? 0,
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
    assert.ok(sent.some(item => item.text.includes('模型返回了 400')), JSON.stringify(sent))
  })

  it('被前置条件挡下时说清楚（这不是等审批）', async () => {
    const { channel, sent, emit } = setup()
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', { type: 'turn/end', data: { reason: { kind: 'blocked' } } })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(sent.some(item => item.text.includes('前置条件')))
  })

  it('长度截断时说清楚，而不是沉默', async () => {
    const { channel, sent, emit } = setup()
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(sent.some(item => item.text.includes('长度上限')))
  })

  it('跑太久会先回一句「还在弄」', async () => {
    const { channel, sent } = setup({ progressAfterMs: 20 })
    await channel.handle(userMessage())
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.ok(sent.some(item => item.text.includes('还在弄')), JSON.stringify(sent))
  })

  it('正常结束时不多嘴', async () => {
    const { channel, sent, emit } = setup()
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(sent.length, 0)
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
      replies: new ReplyQueue({ send: async () => {}, sleep: async () => {} }),
      events,
      report: () => {},
      sleep: async () => {},
      mergeWindowMs: 0,
      progressAfterMs: 0,
      cwd: '/work',
      sendFiles: async (peerId, paths, token) => { sentFiles.push({ peerId, paths, token }) },
    })
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', {
      type: 'deliverables/presented',
      data: { files: [{ path: 'out/报告.docx' }, { path: '/abs/表格.xlsx' }, { nope: 1 }] },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(sentFiles.length, 1)
    assert.deepEqual(sentFiles[0]?.paths, ['/work/out/报告.docx', '/abs/表格.xlsx'])
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
      replies: new ReplyQueue({ send: async (_peer, text) => { sent.push(text) }, sleep: async () => {} }),
      events,
      report: () => {},
      sleep: async () => {},
      mergeWindowMs: 0,
      progressAfterMs: 0,
      sendFiles: async () => { throw new Error('文件太大') },
    })
    await channel.handle(userMessage())
    emit('channel-persona-wxid-owner', { type: 'deliverables/presented', data: { files: [{ path: '/a.docx' }] } })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(sent.some(text => text.includes('文件太大')), JSON.stringify(sent))
  })
})

describe('设置卡片', () => {
  function setup() {
    const { sessions, delivered } = fakeSessions()
    const { events, emit } = fakeEvents()
    const sent: string[] = []
    const saved: Record<string, unknown>[] = []
    let current = { enabled: true }
    const settings = {
      get: async () => current,
      save: async (_peer: string, next: typeof current) => { current = next; saved.push(next); return next },
    }
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
      progressAfterMs: 0,
      settings: settings as never,
    })
    return { channel, sent, saved, delivered, emit }
  }

  it('/menu 发一张卡片', async () => {
    const { channel, sent } = setup()
    await channel.handle(userMessage({ message_id: 'm1', item_list: [{ type: 1, text_item: { text: '/menu' } }] }))
    assert.equal(sent.length, 1)
    assert.match(sent[0] ?? '', /设置/)
    assert.match(sent[0] ?? '', /1 {2}人格/)
  })

  it('回数字打开分条设置，再选项只回一行确认', async () => {
    const { channel, sent, saved } = setup()
    await channel.handle(userMessage({ message_id: 'm1', item_list: [{ type: 1, text_item: { text: '菜单' } }] }))
    await channel.handle(userMessage({ message_id: 'm2', item_list: [{ type: 1, text_item: { text: '4' } }] }))
    await channel.handle(userMessage({ message_id: 'm3', item_list: [{ type: 1, text_item: { text: '1' } }] }))
    assert.equal(saved.length, 1)
    assert.equal(saved[0]?.['split'], 'sentence')
    assert.equal(sent.length, 3)
    assert.match(sent[sent.length - 1] ?? '', /分条：按句子/)
  })

  it('非数字消息会收起卡片并照常进模型', async () => {
    const { channel, sent, delivered } = setup()
    await channel.handle(userMessage({ message_id: 'm1', item_list: [{ type: 1, text_item: { text: '/menu' } }] }))
    await channel.handle(userMessage({ message_id: 'm2', item_list: [{ type: 1, text_item: { text: '帮我看看桌面' } }] }))
    assert.equal(delivered.length, 1)
    assert.match(delivered[0]?.text ?? '', /帮我看看桌面/)
    assert.equal(sent.length, 1)
  })

  it('0 收起卡片', async () => {
    const { channel, sent } = setup()
    await channel.handle(userMessage({ message_id: 'm1', item_list: [{ type: 1, text_item: { text: '/menu' } }] }))
    await channel.handle(userMessage({ message_id: 'm2', item_list: [{ type: 1, text_item: { text: '0' } }] }))
    assert.match(sent[sent.length - 1] ?? '', /收起来/)
  })

  it('进人格面板后选序号会切换', async () => {
    const { channel, sent, saved } = setup()
    await channel.handle(userMessage({ message_id: 'm1', item_list: [{ type: 1, text_item: { text: '/menu' } }] }))
    await channel.handle(userMessage({ message_id: 'm2', item_list: [{ type: 1, text_item: { text: '1' } }] }))
    assert.match(sent[sent.length - 1] ?? '', /人格/)
    // 这里的人格目录是空的：选一个不存在的序号只是再发一次面板，不能崩。
    await channel.handle(userMessage({ message_id: 'm3', item_list: [{ type: 1, text_item: { text: '1' } }] }))
    assert.match(sent[sent.length - 1] ?? '', /人格/)
    assert.equal(saved.length, 0)
  })
})

describe('记忆标记', () => {
  it('标记不进聊天，但会被记住', async () => {
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
      progressAfterMs: 0,
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
      data: { message: { content: [{ type: 'text', text: '记下了。[记住: 用户叫阿彬]' }] } },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(sent, ['记下了。'])
    assert.deepEqual(remembered, [['用户叫阿彬']])
  })
})
