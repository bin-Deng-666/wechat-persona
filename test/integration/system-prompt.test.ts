/** 使用真实 DSH 提示词组装器验证会话隔离、热更新和注册生命周期。 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { PeerSystemPrompt, PERSONA_SECTION } from '../../src/dsh/system-prompt.ts'
import { PeerMemory } from '../../src/memory/store.ts'
import { preference } from '../helpers/memory.ts'
import { ChatSettingsStore } from '../../src/chat/settings.ts'
import { PersonaStore } from '../../src/persona/store.ts'
import { StickerLibrary } from '../../src/stickers/library.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'peer-system-prompt-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const ctx = new Context()
  new SystemPrompt(ctx, { personaSuffix: '宿主工具执行规则' })
  const settings = new ChatSettingsStore(join(root, 'chats'))
  const memory = new PeerMemory(join(root, 'memory'))
  const stickers = new StickerLibrary(join(root, 'stickers'))
  const prompts = new PeerSystemPrompt({ personas: new PersonaStore(join(root, 'personas')), settings,
    defaultPersona: () => 'alpha', memory, stickers, now: () => new Date('2026-10-26T14:05:00+08:00'), timeZone: 'Asia/Shanghai' })
  t.after(() => { prompts.dispose() })
  async function card(id: string, name: string, identity = '你是{{name}}，{{peer}}的搭档。') {
    const file = join(root, 'personas', id, 'persona.json')
    await mkdir(join(root, 'personas', id), { recursive: true })
    await writeFile(file, JSON.stringify({ id, name, prompt: { identity, rules: ['不知道就说不知道'] } }))
    const at = new Date(Date.now() + 2000)
    await utimes(file, at, at)
  }
  await card('alpha', '甲')
  await card('beta', '乙')
  function agent(peerId?: string, parent?: object) {
    const key = {}
    const scope = createScope(ctx, key, parent === undefined ? undefined : { parent })
    t.after(async () => { await scope.dispose() })
    if (peerId !== undefined) prompts.install(scope.ctx, key, peerId)
    const assembly = async () => await ctx.systemPrompt.assemble({ scope: key, agent: key as never })
    return { key, ctx: scope.ctx, assembly, render: async () => renderPrompt(await assembly()) }
  }
  return { root, ctx, settings, memory, stickers, prompts, card, agent }
}

describe('PeerSystemPrompt', () => {
  it('真正进入 system 组装，保留宿主规则；联系人、GUI 与子 agent 不串人格', async t => {
    const f = await fixture(t)
    await f.settings.save('u2', { enabled: true, personaId: 'beta' })
    const first = f.agent('u1')
    const second = f.agent('u2')
    const gui = f.agent()
    const child = f.agent(undefined, first.key)
    const assembly = await first.assembly()
    assert.equal(assembly.sections.filter(section => section.name === PERSONA_SECTION).length, 1)
    assert.match(renderPrompt(assembly), /你是甲，u1的搭档/)
    assert.match(renderPrompt(assembly), /宿主工具执行规则/)
    assert.match(await second.render(), /你是乙，u2的搭档/)
    for (const other of [gui, child]) assert.doesNotMatch(await other.render(), /微信通道|你是甲|你是乙/)
    f.prompts.install(first.ctx, first.key, 'u1')
    assert.equal((await first.assembly()).sections.filter(section => section.name === PERSONA_SECTION).length, 1)
    f.prompts.dispose()
    assert.doesNotMatch(await first.render(), /微信通道/)
  })

  it('切人格、改卡片、记忆新增/清空和聊天长度在下一次请求生效', async t => {
    const f = await fixture(t)
    const agent = f.agent('u1')
    assert.match(await agent.render(), /你是甲/)
    await f.settings.save('u1', { enabled: true, personaId: 'beta', maxChars: 200 })
    await f.card('beta', '新乙', '你是{{name}}，保留字面 {{not_a_harness_variable}}。')
    await preference(f.memory, 'u1', '对方喜欢散步')
    const changed = await agent.render()
    assert.match(changed, /你是新乙/)
    assert.match(changed, /通常约 120 字/)
    assert.doesNotMatch(changed, /通常约 200 字/)
    assert.match(changed, /对方喜欢散步/)
    assert.match(changed, /\{\{not_a_harness_variable\}\}/)
    await f.memory.clear('u1')
    assert.doesNotMatch(await agent.render(), /对方喜欢散步/)
  })

  it('表情识别目录动态进入系统提示词，并限定来源联系人', async t => {
    const f = await fixture(t)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const image = await f.stickers.capture('u1', png, 'image/png')
    assert.ok(image)
    const first = f.agent('u1')
    const second = f.agent('u2')
    assert.match(await first.render(), new RegExp(image.id))
    assert.doesNotMatch(await second.render(), new RegExp(image.id))
    await f.stickers.annotate('u1', [{ id: image.id, name: '开心', description: '小猫笑起来', scenes: '开心或赞同' }])
    const prompt = await first.render()
    assert.match(prompt, /小猫笑起来/)
    assert.match(prompt, /开心或赞同/)
    assert.match(prompt, /\[分条\]/)
    assert.match(prompt, /通常一条消息即可/)
    assert.match(prompt, /不主动搭话/)
  })

  it('新代次和恢复后的新 agent 都获得完整系统人格，无首轮状态依赖', async t => {
    const f = await fixture(t)
    await preference(f.memory, 'u1', '对方喜欢茶')
    for (let index = 0; index < 3; index += 1) {
      const agent = f.agent('u1')
      assert.match(await agent.render(), /你是甲/)
      assert.match(await agent.render(), /对方喜欢茶/)
    }
  })
})
