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

/** 已知命令及其一句话说明。 */
export const COMMANDS: readonly { name: string; usage: string; description: string }[] = [
  { name: 'help', usage: '帮助', description: '列出这些命令' },
  { name: 'new', usage: '新对话', description: '开一段新对话（旧记录保留，不再带上下文）' },
  { name: 'compact', usage: '压缩', description: '把当前对话的旧历史压成摘要，腾出上下文' },
  { name: 'status', usage: '状态', description: '当前人格、会话代次、上下文轮数' },
  { name: 'persona', usage: '人格 [id]', description: '查看或切换这个聊天的人格' },
  { name: 'style', usage: '分条 [字数|按句|按段|不切|恢复]', description: '看或改回答的分条方式' },
  { name: 'stop', usage: '停止', description: '打断正在跑的这一轮' },
  { name: 'menu', usage: '菜单 / 设置', description: '打开设置卡片（人格/模型/记忆/分条）' },
  { name: '表情', usage: '表情 [收 名字|发 名字]', description: '看表情库、收藏或发送表情' },
]

const CHINESE_COMMANDS: Record<string, string> = {
  '菜单': 'menu', '设置': 'menu', '帮助': 'help', '新对话': 'new', '压缩': 'compact', '压缩对话': 'compact',
  '状态': 'status', '人格': 'persona', '分条': 'style', '停止': 'stop', '表情': '表情',
}
const STYLE_ARGUMENTS: Record<string, string> = {
  '按句': 'sentence', '按段': 'paragraph', '不切': 'none', '恢复': 'reset',
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
  const name = slash ? (CHINESE_COMMANDS[head] ?? head.toLowerCase()) : CHINESE_COMMANDS[head]
  if (name === undefined || name === '') return undefined
  const args = rest.filter(part => part !== '')
  // 不带参数的中文指令必须独占整条消息；“菜单怎么设计”是正常聊天。
  if (!slash && args.length > 0) {
    if (name === 'persona' && (args.length !== 1 || !/^[a-z0-9-]{1,32}$/u.test(args[0]!))) return undefined
    if (name === 'style' && (args.length !== 1 || !/^(?:\d+|按句|按段|不切|恢复|sentence|paragraph|none|reset)$/u.test(args[0]!))) return undefined
    if (name === '表情' && !['收', '收下', '发', '发送'].includes(args[0]!)) return undefined
    if (!['persona', 'style', '表情'].includes(name)) return undefined
  }
  return { name, args: name === 'style' ? args.map(arg => STYLE_ARGUMENTS[arg] ?? arg) : args }
}

/** `/help` 的回复。 */
export function formatHelp(): string {
  return ['可用命令：', ...COMMANDS.map(command => `${command.usage} —— ${command.description}`)].join('\n')
}

/** 未知命令的回复。 */
export function formatUnknown(name: string): string {
  return `没有 /${name} 这个命令。发“帮助”看全部。`
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
    `人格：${input.personaName}（${input.personaId}）`,
    `对话：第 ${String(input.generation + 1)} 段${input.generation > 0 ? `（代次 g${String(input.generation)}）` : ''}`,
    `累计消息：${String(input.turns)} 条`,
    `权限：${input.permission}`,
  ]
  if (input.lastActive !== undefined) lines.push(`最近活跃：${input.lastActive}`)
  lines.push('发“新对话”重新开始，发“人格”换人格。')
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
  if (switched !== undefined) return `已切到「${switched.name}」（${switched.id}），下一条消息生效。`
  const list = choices.map(choice => `${choice.id === current ? '→ ' : '  '}${choice.id} ${choice.name}`)
  return ['可用人格：', ...list, '', '用“人格 <id>”切换，或发“菜单”选择。'].join('\n')
}

/** `/new` 的回复。 */
export function formatNewChat(generation: number): string {
  return `已开新对话（第 ${String(generation + 1)} 段）。之前的内容还在记录里，但这轮开始不再带进上下文。`
}

/**
 * 「压缩」的回复。
 * @param outcome - 压缩结论。
 */
export function formatCompact(outcome: CompactOutcome): string {
  switch (outcome.kind) {
    case 'done':
      return `已压缩 ${String(outcome.shadowed)} 条历史（约 ${String(outcome.tokens)} tokens）。旧记录还留在会话里，只是不再进入上下文。`
    case 'nothing':
      return '这段对话还没有可压缩的历史。'
    case 'busy':
      return '现在有一轮正在跑，等它跑完再压缩。'
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

/** `/style` 的输入。 */
export interface StyleInput {
  /** 每条气泡的目标字数。 */
  maxChars: number
  /** 切分粒度。 */
  split: 'paragraph' | 'sentence' | 'none'
  /** 这些值是不是这个聊天自己的设置（否则来自人格卡）。 */
  overridden: boolean
}

/**
 * `/style` 的回显。
 * @param input - 当前生效的发送形态。
 */
export function formatStyle(input: StyleInput): string {
  const lines = [
    `分条：每条约 ${String(input.maxChars)} 字，按${
      input.split === 'sentence' ? '句子' : input.split === 'none' ? '不切' : '段落'
    }切（不超过 ${String(input.maxChars)} 字就一条发完）`,
    `来源：${input.overridden ? '这个聊天的设置' : '人格卡'}（“分条 恢复”恢复人格卡）`,
  ]
  lines.push('调整：分条 160 改字数；分条 按句；分条 不切。')
  return lines.join('\n')
}
