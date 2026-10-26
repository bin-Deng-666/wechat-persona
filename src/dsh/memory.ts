/** Agent-local memory and task-state capabilities. Child agents cannot write through inherited tools. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ConversationStore } from '../chat/history.ts'
import { MemoryCapture, type MemoryActivity } from '../memory/capture.ts'
import { TYPES } from '../memory/model.ts'
import type { PeerMemory } from '../memory/store.ts'

const json = (value: unknown) => JSON.parse(JSON.stringify(value))
const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
export function installMemoryTools(options: {
  ctx: Context; agent: object; peerId: string; memory: PeerMemory; history: ConversationStore
  activity: () => MemoryActivity | undefined
}): () => void {
  const tools = options.ctx.get('tools') as Context['tools'] | undefined
  if (!tools) return () => {}
  const capture = new MemoryCapture(options.memory, options.history, options.peerId, options.activity)
  const guard = (exec: ToolRunContext) => {
    if (exec.agent !== options.agent) throw new Error('此工具只属于当前微信联系人会话')
    exec.signal.throwIfAborted()
  }
  const dispose = [
    tools.register(defineTool({ name: 'wechat_memory_search', description: '检索当前联系人的个人记忆。保存前去重；相关话题按需回忆。返回真实 ID、版本与原话来源。',
      parameters: { query: { type: 'string', required: true }, id: { type: 'string' } }, output,
      execute: async (args, exec) => { guard(exec); return json({ memories: capture.search(args.query, args.id) }) },
    })),
    tools.register(defineTool({ name: 'wechat_memory_write', description: '保存、更正或按当前明确请求删除个人记忆。必须先检索；用来源列表的 entryId 和逐字 quote，不记录项目任务。静默执行。',
      parameters: {
        action: { type: 'string', enum: ['add', 'update', 'delete'], required: true },
        entryId: { type: 'string', required: true }, quote: { type: 'string', required: true }, reason: { type: 'string', required: true },
        title: { type: 'string' }, content: { type: 'string' }, type: { type: 'string', enum: [...TYPES] },
        scope: { type: 'string' }, certainty: { type: 'string', enum: ['明确', '当前倾向', '探索中'] }, tags: { type: 'array', items: { type: 'string' } },
        targetId: { type: 'string' }, targetVersion: { type: 'integer' }, explicitRequestQuote: { type: 'string' },
      }, output,
      execute: async (args, exec) => { guard(exec); return json(await capture.write(args, exec.signal)) },
    })),
    tools.register(defineTool({ name: 'wechat_task_update', description: '维护多步骤任务的当前状态，以整份快照替换旧状态。保留用户最新约束、已完成步骤、待办和待确认事项；普通闲聊不调用。状态在上下文压缩后仍可见。',
      parameters: { goal: { type: 'string', required: true }, constraints: { type: 'array', items: { type: 'string' }, required: true },
        completed: { type: 'array', items: { type: 'string' }, required: true }, pending: { type: 'array', items: { type: 'string' }, required: true }, waitingFor: { type: 'string', required: true } }, output,
      execute: async (args, exec) => {
        guard(exec)
        const activity = options.activity()
        if (!activity || activity.signal.aborted) throw new Error('没有当前用户任务')
        if (JSON.stringify(args).length > 12000) throw new Error('任务快照过长，请保留关键目标和约束')
        await options.history.saveTask(options.peerId, { ...args, generation: activity.generation }, AbortSignal.any([exec.signal, activity.signal]))
        return { status: 'saved' }
      },
    })),
  ]
  return () => { for (const off of dispose.reverse()) off() }
}
