/** Exercise real scoped DSH tool registration and dispatch, not just the memory class. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { installMemoryTools } from '../../src/dsh/memory.ts'
import { ConversationStore } from '../../src/chat/history.ts'
import { PeerMemory } from '../../src/memory/store.ts'

describe('微信会话的记忆工具', () => {
  it('真实注册/派发、证据写入、任务快照与联系人/子 agent 隔离', async t => {
    const root = await mkdtemp(join(tmpdir(), 'wechat-memory-tools-'))
    const ctx = new Context(); new SystemPrompt(ctx, {}); new ToolRuntime(ctx)
    const owner = { id: 'wechat-owner' }, other = { id: 'other' }, child = { id: 'child' }
    const scope = createScope(ctx, owner), otherScope = createScope(ctx, other), childScope = createScope(ctx, child, { parent: owner })
    const history = new ConversationStore(join(root, 'history'))
    const memory = new PeerMemory(join(root, 'memory')); await memory.load()
    const input = (await history.receive('u1', 0, { message_id: 'original', from_user_id: 'u1' }, '我希望回答简单直接', Date.now())).record
    const controller = new AbortController()
    const off = installMemoryTools({ ctx: scope.ctx, agent: owner, peerId: 'u1', memory, history,
      activity: () => ({ id: 'activity', generation: 0, inputIds: [input.id], signal: controller.signal }) })
    t.after(async () => { off(); await childScope.dispose(); await otherScope.dispose(); await scope.dispose(); await rm(root, { recursive: true, force: true }) })
    const schema = await ctx.systemPrompt.assemble({ scope: owner, agent: owner as never })
    assert.ok(schema.tools.some(tool => tool.name === 'wechat_memory_write'))
    assert.ok(!(await ctx.systemPrompt.assemble({ scope: other, agent: other as never })).tools.some(tool => tool.name === 'wechat_memory_write'))
    let callId = 0
    const execute = async (name: string, args: unknown, agent = owner) => await ctx.tools.execute({ callId: String(++callId) as never, name, arguments: args, agent: agent as never, signal: new AbortController().signal })
    assert.equal((await execute('wechat_memory_search', { query: '回答' })).isError, false)
    const written = await execute('wechat_memory_write', { action: 'add', entryId: input.id, quote: input.text, title: '沟通偏好', content: '用户希望回答简单直接', type: '稳定偏好', scope: '日常沟通', certainty: '明确', tags: ['回答'], reason: '未来可据此调整表达' })
    assert.equal(written.isError, false, JSON.stringify(written))
    assert.equal(memory.get('u1').length, 1)
    assert.equal((await execute('wechat_memory_search', { query: '回答' }, child)).isError, true)
    assert.equal((await execute('wechat_memory_search', { query: '回答' }, other)).isError, true)
    const task = await execute('wechat_task_update', { goal: '起草邮件', constraints: ['不要发送'], completed: [], pending: ['写正文'], waitingFor: '' })
    assert.equal(task.isError, false, JSON.stringify(task))
    assert.match(await history.context('u1', 0), /不要发送/)
    off()
    assert.ok(!(await ctx.systemPrompt.assemble({ scope: owner, agent: owner as never })).tools.some(tool => tool.name === 'wechat_memory_write'))
  })
})
