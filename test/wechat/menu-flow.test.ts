/** 用真实通道、持久化设置和发送队列验证微信菜单交互。 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, type TestContext } from 'node:test'
import { Channel, type ChannelOptions } from '../../src/wechat/channel.ts'
import { createAccessPolicy } from '../../src/wechat/access.ts'
import { BUILTIN_DEFAULT, PersonaStore, seedDefaultPersona } from '../../src/persona/store.ts'
import { ChatSettingsStore } from '../../src/chat/settings.ts'
import { PeerGenerations } from '../../src/chat/generations.ts'
import { ReplyQueue } from '../../src/reply/queue.ts'
import { MENU_TTL_MS } from '../../src/wechat/menu.ts'

async function setup(t: TestContext, extra: Partial<ChannelOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-menu-'))
  await seedDefaultPersona(join(root, 'personas'))
  const sent: { peer: string; text: string; token?: string }[] = [], delivered: string[] = []
  const settings = new ChatSettingsStore(join(root, 'chats'))
  const generations = new PeerGenerations(join(root, 'generations.json'))
  let now = 1000, sequence = 0, cleared = 0
  const memory = { get: () => [], legacy: () => cleared ? [] : ['测试记忆'], clear: async () => { cleared++ } }
  const channel = new Channel({
    api: {} as ChannelOptions['api'], account: { baseUrl: 'https://test.invalid', token: 'test', userId: 'owner' },
    sessions: { deliver: async (_peer: string, message: { content: { text?: string }[] }) => { delivered.push(message.content.map(part => part.text ?? '').join('')) } } as unknown as ChannelOptions['sessions'],
    access: createAccessPolicy({ allow: 'owner,other' }),
    personas: new PersonaStore(join(root, 'personas')), defaultPersona: 'default',
    replies: new ReplyQueue({ send: async (peer, text, token) => { sent.push({ peer, text, token }) }, sleep: async () => {} }),
    events: { on: () => () => {} }, settings, generations,
    memory: memory as unknown as ChannelOptions['memory'],
    mergeWindowMs: 0, now: () => now, ...extra,
  })
  t.after(async () => { await channel.stop(); await rm(root, { force: true, recursive: true }) })
  const send = async (text: string, peer = 'owner') => {
    const id = `input-${++sequence}`
    await channel.handle({ message_id: id, from_user_id: peer, message_type: 1, context_token: id, item_list: [{ type: 1, text_item: { text } }] })
    await channel.whenIdle()
  }
  return { channel, send, sent, settings, delivered, memory, generations, personaRoot: join(root, 'personas'), tick: (ms: number) => { now += ms }, cleared: () => cleared }
}

it('中文入口、逐级返回与关闭都在微信内完成', async t => {
  const f = await setup(t)
  await f.send('设置')
  assert.match(f.sent.at(-1)!.text, /^⚙️ 聊天设置\n/)
  await f.send('1')
  assert.match(f.sent.at(-1)!.text, /^🎭 切换人格/)
  await f.send('返回')
  assert.match(f.sent.at(-1)!.text, /^⚙️ 聊天设置\n/)
  await f.send('3')
  assert.match(f.sent.at(-1)!.text, /^📝 个人记忆/)
  await f.send('0')
  assert.match(f.sent.at(-1)!.text, /^⚙️ 聊天设置\n/)
  await f.send('关闭')
  assert.match(f.sent.at(-1)!.text, /已关闭/)
  await f.send('1')
  assert.deepEqual(f.delivered, ['1'])
})

it('中文分类直接打开对应菜单，帮助无网页链接', async t => {
  const f = await setup(t)
  for (const [input, title] of [['人格', '切换人格'], ['记忆', '个人记忆'], ['表情', '表情库'], ['菜单', '设置'], ['/settings', '设置'], ['帮助', '使用帮助']]) {
    await f.send(input!)
    assert.ok(f.sent.at(-1)!.text.includes(title!))
    assert.doesNotMatch(f.sent.at(-1)!.text, /https?:|网页|小程序/)
  }
  assert.deepEqual(f.delivered, [])
})

it('清空记忆需要确认，取消不改数据', async t => {
  const f = await setup(t)
  await f.send('记忆')
  await f.send('1')
  assert.match(f.sent.at(-1)!.text, /确认清空/)
  assert.equal(f.cleared(), 0)
  await f.send('0')
  assert.match(f.sent.at(-1)!.text, /^📝 个人记忆/)
  assert.equal(f.cleared(), 0)
  await f.send('1')
  await f.send('1')
  assert.equal(f.cleared(), 1)
  assert.match(f.sent.at(-1)!.text, /已清空/)
})

it('数字只在对应联系人的有效菜单内处理', async t => {
  const f = await setup(t)
  await f.send('设置')
  await f.send('1', 'other')
  assert.deepEqual(f.delivered, ['1'])
  f.tick(MENU_TTL_MS + 1)
  await f.send('2')
  assert.deepEqual(f.delivered, ['1', '2'])
  assert.equal((await f.settings.get('owner')).split, undefined)
})

it('菜单和帮助整条显示，沿用本条消息的回复令牌', async t => {
  const f = await setup(t)
  await f.settings.update('owner', current => ({ ...current, maxChars: 20, split: 'sentence' }))
  await f.send('设置')
  assert.equal(f.sent.length, 1)
  assert.match(f.sent[0]!.text, /1  换人格[\s\S]*6  压缩对话/)
  assert.equal(f.sent[0]!.token, 'input-1')
  await f.send('帮助')
  assert.equal(f.sent.length, 2)
  assert.match(f.sent[1]!.text, /设置 ·[\s\S]*表情 发 名字/)
  assert.doesNotMatch(f.sent[1]!.text, /分条|网页|小程序/)
})

it('宿主不支持热切时，换模型回退到新一段会话', async t => {
  const catalog = async () => ({
    choices: [
      { provider: 'deepseek-account', model: 'deepseek-flash' },
      { provider: 'workbuddy', model: 'glm-5.3' },
    ],
    current: { provider: 'deepseek-account', model: 'deepseek-flash' },
  })
  const f = await setup(t, { catalog })
  await f.send('设置')
  assert.match(f.sent.at(-1)!.text, /2  换模型 · deepseek-account\/deepseek-flash/)
  await f.send('2')
  assert.match(f.sent.at(-1)!.text, /🤖 换模型/)
  assert.match(f.sent.at(-1)!.text, /1  跟随 DSH 默认/)
  assert.match(f.sent.at(-1)!.text, /2  deepseek-account\/deepseek-flash  ✓/)
  assert.match(f.sent.at(-1)!.text, /3  workbuddy\/glm-5\.3/)
  await f.send('3')
  assert.deepEqual((await f.settings.get('owner')).model, { provider: 'workbuddy', model: 'glm-5.3' })
  assert.match(f.sent.at(-1)!.text, /已换到 workbuddy\/glm-5\.3/)
  assert.match(f.sent.at(-1)!.text, /第 2 段/)
  assert.equal(await f.generations.get('owner'), 1)
  await f.send('设置')
  assert.match(f.sent.at(-1)!.text, /2  换模型 · workbuddy\/glm-5\.3/)
})


it('宿主支持时会话内换模型，不重开会话也不丢上下文', async t => {
  const catalog = async () => ({
    choices: [
      { provider: 'deepseek-account', model: 'deepseek-flash' },
      { provider: 'workbuddy', model: 'glm-5.3' },
    ],
    current: { provider: 'deepseek-account', model: 'deepseek-flash' },
  })
  const switched: { peerId: string; generation: number; provider: string; model: string }[] = []
  const f = await setup(t, {
    catalog,
    sessions: {
      deliver: async () => {},
      selectModel: async (peerId: string, generation: number, choice: { provider: string; model: string }) => {
        switched.push({ peerId, generation, ...choice })
        return true
      },
    } as unknown as ChannelOptions['sessions'],
  })
  await f.send('设置')
  await f.send('2')
  await f.send('3')
  assert.deepEqual(switched, [{ peerId: 'owner', generation: 0, provider: 'workbuddy', model: 'glm-5.3' }])
  assert.match(f.sent.at(-1)!.text, /已换到 workbuddy\/glm-5\.3/)
  assert.doesNotMatch(f.sent.at(-1)!.text, /第 2 段/)
  assert.equal(await f.generations.get('owner'), 0)
})

it('重复选中实际生效的目录默认模型只回一句，不重开会话', async t => {
  const catalog = async () => ({ choices: [{ provider: 'workbuddy', model: 'glm-5.3' }], current: { provider: 'workbuddy', model: 'glm-5.3' } })
  const f = await setup(t, { catalog })
  assert.equal((await f.settings.get('owner')).model, undefined)
  await f.send('设置')
  await f.send('2')
  await f.send('2')
  assert.match(f.sent.at(-1)!.text, /现在用的就是 workbuddy\/glm-5\.3/)
  assert.equal(await f.generations.get('owner'), 0)
  assert.equal((await f.settings.get('owner')).model, undefined)
})

it('不支持热切时，跟随默认只清覆盖并如实说明下一段生效', async t => {
  const catalog = async () => ({ choices: [{ provider: 'workbuddy', model: 'glm-5.3' }], current: { provider: 'deepseek-account', model: 'deepseek-flash' } })
  const f = await setup(t, { catalog })
  await f.settings.update('owner', current => ({ ...current, model: { provider: 'workbuddy', model: 'glm-5.3' } }))
  await f.send('设置')
  await f.send('2')
  await f.send('1')
  const settings = await f.settings.get('owner')
  assert.equal(settings.model, undefined)
  assert.equal(settings.enabled, true)
  // 这个夹具没有会话内切换能力：必须如实说明当前会话仍用原模型。
  assert.match(f.sent.at(-1)!.text, /已清除联系人的模型设置/)
  assert.match(f.sent.at(-1)!.text, /下一段会话生效/)
  assert.equal(await f.generations.get('owner'), 0)
  await f.send('设置')
  assert.match(f.sent.at(-1)!.text, /2  换模型 · deepseek-account\/deepseek-flash/)
})


it('能热切时“跟随 DSH 默认”立即生效，并保留上下文', async t => {
  const catalog = async () => ({
    choices: [{ provider: 'workbuddy', model: 'glm-5.3' }],
    current: { provider: 'deepseek-account', model: 'deepseek-flash' },
  })
  const switched: { provider: string; model: string }[] = []
  const f = await setup(t, {
    catalog,
    sessions: {
      deliver: async () => {},
      selectModel: async (_peer: string, _generation: number, choice: { provider: string; model: string }) => {
        switched.push(choice)
        return true
      },
    } as unknown as ChannelOptions['sessions'],
  })
  await f.settings.update('owner', current => ({ ...current, model: { provider: 'workbuddy', model: 'glm-5.3' } }))
  await f.send('设置')
  await f.send('2')
  await f.send('1')
  assert.deepEqual(switched, [{ provider: 'deepseek-account', model: 'deepseek-flash' }])
  assert.match(f.sent.at(-1)!.text, /已设为跟随 DSH 默认/)
  assert.match(f.sent.at(-1)!.text, /上下文继续保留/)
  assert.equal((await f.settings.get('owner')).model, undefined)
  assert.equal(await f.generations.get('owner'), 0)
})

it('长模型列表可以双向翻页，未知数字重发当前页，普通聊天不吞消息', async t => {
  const catalog = async () => ({
    choices: Array.from({ length: 18 }, (_, i) => ({ provider: 'workbuddy', model: `m-${i}` })),
    current: { provider: 'workbuddy', model: 'm-0' },
  })
  const f = await setup(t, { catalog })
  await f.send('设置')
  await f.send('2')
  assert.match(f.sent.at(-1)!.text, /第 1\/3 页/)
  await f.send('8')
  assert.match(f.sent.at(-1)!.text, /第 2\/3 页/)
  assert.match(f.sent.at(-1)!.text, /1  workbuddy\/m-6/)
  await f.send('8')
  assert.match(f.sent.at(-1)!.text, /第 3\/3 页/)
  assert.match(f.sent.at(-1)!.text, /1  workbuddy\/m-13/)
  await f.send('8')
  assert.match(f.sent.at(-1)!.text, /第 3\/3 页/)
  assert.match(f.sent.at(-1)!.text, /没有下一页/)
  await f.send('5')
  assert.deepEqual((await f.settings.get('owner')).model, { provider: 'workbuddy', model: 'm-17' })
  assert.equal(await f.generations.get('owner'), 1)
  await f.send('设置')
  await f.send('2')
  await f.send('8')
  await f.send('9')
  assert.match(f.sent.at(-1)!.text, /第 1\/3 页/)
  await f.send('9')
  assert.match(f.sent.at(-1)!.text, /第 1\/3 页/)
  assert.match(f.sent.at(-1)!.text, /没有上一页/)
  await f.send('随便聊聊')
  assert.deepEqual(f.delivered, ['随便聊聊'])
})

it('超过九项的人格可以翻页选择，翻页编号不会误选人格', async t => {
  const f = await setup(t)
  for (let i = 0; i < 11; i++) {
    const id = `persona-${String(i).padStart(2, '0')}`
    await mkdir(join(f.personaRoot, id), { recursive: true })
    await writeFile(join(f.personaRoot, id, 'persona.json'), JSON.stringify({ ...BUILTIN_DEFAULT, id, name: `人格 ${String(i).padStart(2, '0')}` }))
  }
  await f.send('人格')
  assert.match(f.sent.at(-1)!.text, /第 1\/2 页/)
  assert.doesNotMatch(f.sent.at(-1)!.text, /人格 07/)
  await f.send('8')
  assert.match(f.sent.at(-1)!.text, /第 2\/2 页/)
  assert.match(f.sent.at(-1)!.text, /1  人格 06/)
  await f.send('1')
  assert.equal((await f.settings.get('owner')).personaId, 'persona-06')
  assert.match(f.sent.at(-1)!.text, /已切到「人格 06」/)
  await f.send('9')
  assert.deepEqual(f.delivered, ['9'])
})

it('没有模型目录时设置里仍可打开，但只给出说明', async t => {
  const f = await setup(t)
  await f.send('设置')
  await f.send('2')
  assert.match(f.sent.at(-1)!.text, /还没有可用的模型/)
  assert.match(f.sent.at(-1)!.text, /当前：跟随 DSH 默认/)
})

it('分条不再作为触发指令，也不会修改聊天设置', async t => {
  const f = await setup(t)
  await f.send('分条')
  await f.send('分条 160')
  assert.deepEqual(f.delivered, ['分条', '分条 160'])
  assert.equal((await f.settings.get('owner')).maxChars, undefined)
})

it('菜单发起的压缩使用当前代次，并能接收中文停止', { timeout: 5000 }, async t => {
  let generation: number | undefined, signal: AbortSignal | undefined
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const f = await setup(t, { compact: async (_peer, current, abort) => {
    generation = current; signal = abort; started()
    return await new Promise(resolve => {
      if (abort?.aborted) resolve({ kind: 'cancelled' })
      else abort?.addEventListener('abort', () => { resolve({ kind: 'cancelled' }) }, { once: true })
    })
  } })
  await f.send('新对话')
  await f.send('设置')
  const pending = f.channel.handle({ message_id: 'compact', from_user_id: 'owner', message_type: 1, item_list: [{ type: 1, text_item: { text: '6' } }] })
  await ready
  assert.equal(generation, 1)
  await f.channel.handle({ message_id: 'stop', from_user_id: 'owner', message_type: 1, item_list: [{ type: 1, text_item: { text: '停止' } }] })
  await pending
  await f.channel.whenIdle()
  assert.equal(signal?.aborted, true)
  assert.ok(f.sent.some(item => item.text.includes('已停止')))
})
