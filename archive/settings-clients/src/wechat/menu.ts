/** 微信内的设置菜单：中文入口、编号选择，五分钟无操作后失效。 */
import { normalizeDigits } from '../../../../src/text/digits.ts'

export type MenuPanel = 'root' | 'personas' | 'memory' | 'clear-memory' | 'style' | 'stickers'

export interface MenuView {
  personaId: string
  personaName: string
  personaChoices: readonly { id: string; name: string }[]
  memoryCount: number
  memoryFacts: readonly string[]
  maxChars: number
  split: 'paragraph' | 'sentence' | 'none'
  overridden: boolean
  stickerCount: number
  stickerNames: readonly string[]
}

export const MENU_TTL_MS = 5 * 60_000
const SPLIT_LABEL: Record<MenuView['split'], string> = {
  paragraph: '按段落', sentence: '按句子', none: '整条发送',
}
const BACK = '回复编号选择 · 0 返回'

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
      const lines = ['切换人格', '']
      if (!view.personaChoices.length) lines.push('暂无可用人格。')
      view.personaChoices.slice(0, 9).forEach((choice, index) => {
        lines.push(`${index + 1}  ${preview(choice.name)}${choice.id === view.personaId ? '（当前）' : ''}`)
      })
      if (view.personaChoices.length > 9) lines.push('', '其他人格可发送「人格 id」切换。')
      return [...lines, '', BACK].join('\n')
    }
    case 'style':
      return [
        '回复分条',
        `当前：${SPLIT_LABEL[view.split]} · 每条约 ${view.maxChars} 字`,
        `来源：${view.overridden ? '这个聊天' : '人格卡'}`,
        '',
        '1  按句子发送',
        '2  按段落发送',
        '3  整条发送',
        '4  每条约 200 字',
        '5  恢复人格卡默认',
        '', BACK,
      ].join('\n')
    case 'memory': {
      const lines = ['个人记忆', '']
      if (!view.memoryCount) {
        lines.push('暂无记忆。', '需要保留的信息，可以直接说「记住……」。')
      } else {
        lines.push(`共 ${view.memoryCount} 条`)
        for (const fact of view.memoryFacts.slice(0, 8)) lines.push(`· ${preview(fact)}`)
        if (view.memoryCount > 8) lines.push(`…还有 ${view.memoryCount - 8} 条`)
        lines.push('', '1  清空记忆')
      }
      return [...lines, '', BACK].join('\n')
    }
    case 'clear-memory':
      return ['清空记忆', '', `将删除这个聊天的 ${view.memoryCount} 条记忆，无法撤销。`, '', '1  确认清空', '0  取消'].join('\n')
    case 'stickers': {
      const lines = ['表情库', '']
      if (!view.stickerCount) {
        lines.push('暂无表情。', '先发图片，再发送「表情 收 名字」收藏。')
      } else {
        lines.push(`共 ${view.stickerCount} 张`)
        for (const name of view.stickerNames.slice(0, 10)) lines.push(`· ${preview(name)}`)
        if (view.stickerCount > 10) lines.push(`…还有 ${view.stickerCount - 10} 张`)
        lines.push('', '发送表情：表情 发 名字', '收藏图片：表情 收 名字')
      }
      return [...lines, '', BACK].join('\n')
    }
    default:
      return [
        '设置',
        `人格 · ${preview(view.personaName)}`,
        '',
        '1  换人格',
        '2  回复分条',
        `3  个人记忆 · ${view.memoryCount} 条`,
        `4  表情库 · ${view.stickerCount} 张`,
        '5  新对话',
        '6  压缩对话',
        '',
        '回复编号选择 · 0 关闭',
        '5 分钟内有效，直接聊天可退出',
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
        case 2: return { kind: 'panel', panel: 'style' }
        case 3: return { kind: 'panel', panel: 'memory' }
        case 4: return { kind: 'panel', panel: 'stickers' }
        case 5: return { kind: 'action', action: 'new-chat' }
        case 6: return { kind: 'action', action: 'compact' }
        default: return { kind: 'unknown' }
      }
    case 'personas': return { kind: 'action', action: `persona-${choice}` }
    case 'memory': return choice === 1 ? { kind: 'panel', panel: 'clear-memory' } : { kind: 'unknown' }
    case 'clear-memory': return choice === 1 ? { kind: 'action', action: 'clear-memory' } : { kind: 'unknown' }
    case 'style': {
      const actions = ['split-sentence', 'split-paragraph', 'split-none', 'max-chars-200', 'style-reset']
      const action = actions[choice - 1]
      return action ? { kind: 'action', action } : { kind: 'unknown' }
    }
    default: return { kind: 'unknown' }
  }
}

export type MenuChoice =
  | { kind: 'close' }
  | { kind: 'panel'; panel: MenuPanel }
  | { kind: 'action'; action: string }
  | { kind: 'unknown' }
