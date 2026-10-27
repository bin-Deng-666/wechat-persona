/** 微信内的设置菜单：中文入口、编号选择，五分钟无操作后失效。 */
import { normalizeDigits } from '../text/digits.ts'

export type MenuPanel = 'root' | 'personas' | 'memory' | 'clear-memory' | 'stickers'

export interface MenuView {
  personaId: string
  personaName: string
  personaChoices: readonly { id: string; name: string }[]
  memoryCount: number
  memoryFacts: readonly string[]
  stickerCount: number
  stickerNames: readonly string[]
}

export const MENU_TTL_MS = 5 * 60_000
const BACK = '回复数字选择 · 0 返回上一级'

/** 仅接受单个数字，兼容全角数字和末尾句号。 */
export function parseChoice(text: string): number | undefined {
  const normalized = normalizeDigits(text).trim().replace(/[。．.]$/u, '')
  return /^\d$/u.test(normalized) ? Number(normalized) : undefined
}

/** 限制预览长度，避免长记忆把菜单挤成多屏。完整内容仍保留在记忆库。 */
function preview(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim()
  const chars = Array.from(line)
  return chars.length > 100 ? chars.slice(0, 100).join('') + '…' : line
}

/** 每个面板保持标题、内容、操作提示三部分，直接作为一条微信消息发送。 */
export function renderMenu(panel: MenuPanel, view: MenuView): string {
  switch (panel) {
    case 'personas': {
      const lines = ['🎭 切换人格', '选一个你喜欢的聊天风格。', '']
      if (!view.personaChoices.length) lines.push('还没有可选的人格。')
      view.personaChoices.slice(0, 9).forEach((choice, index) => {
        lines.push(`${index + 1}  ${preview(choice.name)}${choice.id === view.personaId ? '  ✓ 当前使用' : ''}`)
      })
      if (view.personaChoices.length > 9) lines.push('', '其他人格可发送「人格 id」切换。')
      return [...lines, '', BACK].join('\n')
    }
    case 'memory': {
      const lines = ['📝 个人记忆', '']
      if (!view.memoryCount) {
        lines.push('这里还没有记忆。', '', '想让我记住什么，可以直接告诉我：', '「记住，我喜欢简单直接的回答。」')
      } else {
        lines.push(`已经记下 ${view.memoryCount} 条：`, '')
        for (const fact of view.memoryFacts.slice(0, 8)) lines.push(`· ${preview(fact)}`)
        if (view.memoryCount > 8) lines.push(`…还有 ${view.memoryCount - 8} 条`)
        lines.push('', '1  清空记忆')
      }
      return [...lines, '', BACK].join('\n')
    }
    case 'clear-memory':
      return ['📝 清空记忆', '', `这个聊天的 ${view.memoryCount} 条记忆将被删除。`, '清空后无法恢复，确认继续吗？', '', '1  确认清空', '0  先保留，返回记忆列表'].join('\n')
    case 'stickers': {
      const lines = ['🖼️ 表情库', '']
      if (!view.stickerCount) {
        lines.push('这里还没有收藏的表情。', '', '发来一张喜欢的图片，再给它起个名字：', '表情 收 开心')
      } else {
        lines.push(`${view.stickerCount} 张表情，聊天时可以用：`, '')
        for (const name of view.stickerNames.slice(0, 10)) lines.push(`· ${preview(name)}`)
        if (view.stickerCount > 10) lines.push(`…还有 ${view.stickerCount - 10} 张`)
        lines.push('', '想发一张：表情 发 名字', '想收藏图片：表情 收 名字', '例如：表情 发 开心')
      }
      return [...lines, '', BACK].join('\n')
    }
    default:
      return [
        '⚙️ 聊天设置',
        `当前人格：${preview(view.personaName)}`,
        '',
        '1  换人格 · 选一种聊天风格',
        `2  个人记忆 · 已记下 ${view.memoryCount} 条`,
        `3  表情库 · ${view.stickerCount} 张可用`,
        '',
        '4  新对话 · 从新话题开始',
        '5  压缩对话 · 整理前面的内容',
        '',
        '回复数字选择 · 0 关闭',
        '5 分钟内有效，也可以直接继续聊天',
      ].join('\n')
  }
}

/** 子菜单的 0 返回上一级，主菜单的 0 关闭。 */
export function resolveChoice(panel: MenuPanel, choice: number): MenuChoice {
  if (choice === 0) return panel === 'root'
    ? { kind: 'close' }
    : { kind: 'panel', panel: panel === 'clear-memory' ? 'memory' : 'root' }
  switch (panel) {
    case 'root':
      switch (choice) {
        case 1: return { kind: 'panel', panel: 'personas' }
        case 2: return { kind: 'panel', panel: 'memory' }
        case 3: return { kind: 'panel', panel: 'stickers' }
        case 4: return { kind: 'action', action: 'new-chat' }
        case 5: return { kind: 'action', action: 'compact' }
        default: return { kind: 'unknown' }
      }
    case 'personas': return { kind: 'action', action: `persona-${choice}` }
    case 'memory': return choice === 1 ? { kind: 'panel', panel: 'clear-memory' } : { kind: 'unknown' }
    case 'clear-memory': return choice === 1 ? { kind: 'action', action: 'clear-memory' } : { kind: 'unknown' }
    default: return { kind: 'unknown' }
  }
}

export type MenuChoice =
  | { kind: 'close' }
  | { kind: 'panel'; panel: MenuPanel }
  | { kind: 'action'; action: string }
  | { kind: 'unknown' }
