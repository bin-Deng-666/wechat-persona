/**
 * 微信里的内置命令。
 *
 * 只做解析与文案：执行（换会话、改设置）留在通道运行时里，
 * 这样文案能单测，副作用只有一处。
 *
 * 为什么需要：会话 id 是 peer 的纯函数，用户没有任何办法「重新开始」；
 * 上下文长了也看不见。命令是最小成本的补口。
 *
 * @module wechat-persona/wechat/commands
 */

// 只借类型：压缩结论由 dsh 适配层产出，文案在这里。
import type { CompactOutcome } from '../dsh/compaction.ts'

export interface ParsedCommand {
  /** 不带斜杠的命令名，已转小写。 */
  name: string
  /** 空格分隔的参数。 */
  args: string[]
}

type CommandGroup = '常用入口' | '对话管理' | '表情用法'

/** 指令说明与帮助分组使用同一份清单。 */
export const COMMANDS: readonly { name: string; usage: string; description: string; group: CommandGroup }[] = [
  { name: 'menu', usage: '设置', description: '打开聊天设置', group: '常用入口' },
  { name: 'persona', usage: '人格', description: '选一种喜欢的聊天风格', group: '常用入口' },
  { name: 'memory', usage: '记忆', description: '看看已经记住了哪些事', group: '常用入口' },
  { name: 'status', usage: '状态', description: '查看当前人格和对话情况', group: '常用入口' },
  { name: 'help', usage: '帮助', description: '查看这份指令说明', group: '常用入口' },
  { name: 'new', usage: '新对话', description: '从新话题开始，旧记录保留', group: '对话管理' },
  { name: 'compact', usage: '压缩', description: '整理前面的内容，继续当前对话', group: '对话管理' },
  { name: 'stop', usage: '停止', description: '停止当前任务和待发送的消息', group: '对话管理' },
  { name: '表情', usage: '表情', description: '查看收藏的表情', group: '表情用法' },
  { name: '表情', usage: '表情 收 名字', description: '收藏刚发来的图片', group: '表情用法' },
  { name: '表情', usage: '表情 发 名字', description: '发送指定的表情', group: '表情用法' },
]

const CHINESE_COMMANDS: Record<string, string> = {
  '菜单': 'menu', '设置': 'menu', '记忆': 'memory', '帮助': 'help', '新对话': 'new', '压缩': 'compact', '压缩对话': 'compact',
  '状态': 'status', '人格': 'persona', '停止': 'stop', '表情': '表情',
}

/**
 * 把一条消息解析成命令。
 * @param text - 消息原文。
 * @returns 整条消息是中文指令或斜杠命令时返回解析结果。
 */
export function parseCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim()
  const slash = trimmed.startsWith('/')
  const [head = '', ...rest] = (slash ? trimmed.slice(1) : trimmed).split(/\s+/u)
  const name = slash ? (CHINESE_COMMANDS[head] ?? ({ settings: 'menu' }[head.toLowerCase()] ?? head.toLowerCase())) : CHINESE_COMMANDS[head]
  if (name === undefined || name === '') return undefined
  const args = rest.filter(part => part !== '')
  // 不带参数的中文指令必须独占整条消息；“菜单怎么设计”是正常聊天。
  if (!slash && args.length > 0) {
    if (name === 'persona' && (args.length !== 1 || !/^[a-z0-9-]{1,32}$/u.test(args[0]!))) return undefined
    if (name === '表情' && !['收', '收下', '发', '发送'].includes(args[0]!)) return undefined
    if (!['persona', '表情'].includes(name)) return undefined
  }
  return { name, args }
}

/** `/help` 的回复。 */
export function formatHelp(): string {
  const sections = (['常用入口', '对话管理', '表情用法'] as const).map(group => [
    group,
    ...COMMANDS.filter(command => command.group === group).map(command => `${command.usage} · ${command.description}`),
  ].join('\n'))
  return [
    '📖 使用帮助',
    '想做什么，直接发送对应的中文就好。',
    '',
    sections.join('\n\n'),
    '',
    '例如：先发一张图片，再发送「表情 收 开心」。',
    '',
    '菜单内回复数字选择，「返回」回上一级，「关闭」退出。',
    '「菜单」也能打开设置，「压缩对话」也能整理内容。',
    '指定人格可发送「人格 id」。',
  ].join('\n')
}

/** 未知命令的回复。 */
export function formatUnknown(name: string): string {
  return `暂时没有 /${name} 这个指令。\n发送「帮助」，看看可以怎么用。`
}

/** `/status` 的输入。 */
export interface StatusInput {
  personaId: string
  personaName: string
  /** 会话代次：0 表示第一段对话。 */
  generation: number
  /** 这个聊天已经处理过多少条消息。 */
  turns: number
  /** 最近一次活跃的相对时间描述，例如「3 分钟前」。 */
  lastActive?: string
  /** 权限档位。 */
  permission: string
}

/**
 * `/status` 的回复。
 * @param input - 当前状态。
 */
export function formatStatus(input: StatusInput): string {
  const lines = [
    '📍 当前状态',
    '',
    `人格：${input.personaName}（${input.personaId}）`,
    `对话：第 ${String(input.generation + 1)} 段`,
    `累计消息：${String(input.turns)} 条`,
    `权限：${input.permission}`,
  ]
  if (input.lastActive !== undefined) lines.push(`最近活跃：${input.lastActive}`)
  lines.push('', '想从新话题开始，发送「新对话」。')
  return lines.join('\n')
}

export interface PersonaChoice {
  id: string
  name: string
}

/**
 * `/persona` 的回复。
 * @param current - 当前人格 id。
 * @param choices - 可用人格。
 * @param switched - 已经切换过去的人格（有值时文案是「已切换」）。
 */
export function formatPersona(current: string, choices: readonly PersonaChoice[], switched?: PersonaChoice): string {
  if (switched !== undefined) return `✓ 已切到「${switched.name}」\n下一条消息就会使用这个人格。`
  const list = choices.map(choice => `${choice.id === current ? '→ ' : '  '}${choice.id} ${choice.name}`)
  return ['可用人格：', ...list, '', '用“人格 <id>”切换，或发“设置”选择。'].join('\n')
}

/** `/new` 的回复。 */
export function formatNewChat(generation: number): string {
  return `✨ 已开新对话 · 第 ${String(generation + 1)} 段\n\n可以从新话题开始聊了。\n之前的内容还在记录里，不会带进这段对话。`
}

/**
 * 换模型的回复。
 * @param label - `provider/model`。
 * @param generation - 传了就说明同时开了新对话（模型在建会话时定下）。
 */
export function formatModelSwitch(label: string, generation?: number): string {
  if (generation === undefined) return `✓ 已换到 ${label}\n下一条消息就会用这个模型。`
  return `✓ 已换到 ${label}\n换模型要重新开一段会话，现在是第 ${String(generation + 1)} 段。\n之前的记录还在，不会带进这段对话。`
}

/**
 * 「压缩」的回复。
 * @param outcome - 压缩结论。
 */
export function formatCompact(outcome: CompactOutcome): string {
  switch (outcome.kind) {
    case 'done':
      return `✓ 对话已整理\n\n已压缩 ${String(outcome.shadowed)} 条历史（约 ${String(outcome.tokens)} tokens）。\n旧记录仍然保留，可以继续当前话题。`
    case 'nothing':
      return '这段对话还没有可压缩的历史。\n先继续聊，内容多了再整理就好。'
    case 'busy':
      return '当前任务还在进行中，等它结束后再整理对话。\n需要打断时，可以发送「停止」。'
    case 'cancelled':
      return '压缩被取消了。'
    case 'unavailable':
      return '这个宿主没有提供压缩能力。'
    case 'failed':
      return `压缩没成功：${outcome.message}`
  }
}

/**
 * 把毫秒差说成人话。
 * @param ms - 距今毫秒数。
 */
export function formatAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${String(minutes)} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时前`
  return `${String(Math.floor(hours / 24))} 天前`
}
