/**
 * 微信里的内置命令。
 *
 * 只做解析与文案：执行（换会话、改设置）留在通道运行时里，
 * 这样文案能单测，副作用只有一处。
 *
 * 为什么需要：会话 id 是 peer 的纯函数，用户没有任何办法「重新开始」；
 * 上下文长了也看不见。命令是最小成本的补口。
 *
 * @module wechat-persona/channel/commands
 */

export interface ParsedCommand {
  /** 不带斜杠的命令名，已转小写。 */
  name: string
  /** 空格分隔的参数。 */
  args: string[]
}

/** 已知命令及其一句话说明。 */
export const COMMANDS: readonly { name: string; usage: string; description: string }[] = [
  { name: 'help', usage: '/help', description: '列出这些命令' },
  { name: 'new', usage: '/new', description: '开一段新对话（旧记录保留，不再带上下文）' },
  { name: 'status', usage: '/status', description: '当前人格、会话代次、上下文轮数' },
  { name: 'persona', usage: '/persona [id]', description: '查看或切换这个聊天的人格' },
  { name: 'style', usage: '/style [字数|sentence|paragraph|none|reset]', description: '看或改回答的分条方式' },
  { name: 'stop', usage: '/stop', description: '打断正在跑的这一轮' },
  { name: 'menu', usage: '/menu', description: '打开设置卡片（人格/模型/记忆/主动/分条）' },
  { name: '表情', usage: '/表情 [收 名字]', description: '看表情库，或把对方刚发的图收进库里' },
]

/**
 * 把一条消息解析成命令。
 * @param text - 消息原文。
 * @returns 以 `/` 开头且命令名合法时返回解析结果；否则 undefined（当普通消息处理）。
 */
export function parseCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return undefined
  const [head, ...rest] = trimmed.slice(1).split(/\s+/u)
  const name = head?.toLowerCase() ?? ''
  if (name === '') return undefined
  // 未知命令也算命令：这样能回一句「没有这个命令」，而不是把它发给模型。
  return { name, args: rest.filter(part => part !== '') }
}

/** `/help` 的回复。 */
export function formatHelp(): string {
  return ['可用命令：', ...COMMANDS.map(command => `${command.usage} —— ${command.description}`)].join('\n')
}

/** 未知命令的回复。 */
export function formatUnknown(name: string): string {
  return `没有 /${name} 这个命令。发 /help 看全部。`
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
  lines.push('发 /new 开新对话，/persona 换人格。')
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
  return ['可用人格：', ...list, '', '用 /persona <id> 切换。'].join('\n')
}

/** `/new` 的回复。 */
export function formatNewChat(generation: number): string {
  return `已开新对话（第 ${String(generation + 1)} 段）。之前的内容还在记录里，但这轮开始不再带进上下文。`
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
  /** 一次最多几条。 */
  maxBubbles: number
  /** 这些值是不是这个聊天自己的设置（否则来自人格卡）。 */
  overridden: boolean
}

/**
 * `/style` 的回显。
 * @param input - 当前生效的发送形态。
 */
export function formatStyle(input: StyleInput): string {
  const lines = [
    `分条：最多 ${String(input.maxBubbles)} 条，每条约 ${String(input.maxChars)} 字，按${
      input.split === 'sentence' ? '句子' : input.split === 'none' ? '不切' : '段落'
    }切`,
    `来源：${input.overridden ? '这个聊天的设置' : '人格卡'}（/style reset 恢复人格卡）`,
  ]
  lines.push('调整：/style 160 改字数；/style sentence 按句切；/style none 不切。')
  return lines.join('\n')
}
