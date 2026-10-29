/** 微信内的设置菜单：中文入口、编号选择，五分钟无操作后失效。 */
import { normalizeDigits } from '../text/digits.ts'

export type MenuPanel = 'root' | 'personas' | 'memory' | 'clear-memory' | 'stickers' | 'models'

/** 一个可选的模型。菜单只展示 `provider/model`，与 DSH 目录一一对应。 */
export interface ModelChoice {
  provider: string
  model: string
}

export interface MenuView {
  personaId: string
  personaName: string
  personaChoices: readonly { id: string; name: string }[]
  memoryCount: number
  memoryFacts: readonly string[]
  stickerCount: number
  stickerNames: readonly string[]
  /** 平铺的模型目录，顺序与 DSH 一致。 */
  modelChoices: readonly ModelChoice[]
  /** 当前正在用的模型（`provider/model`）；没有覆盖时是宿主默认。 */
  modelLabel: string
}

export const MENU_TTL_MS = 5 * 60_000
export const MENU_PAGE_SIZE = 7
const BACK = '回复数字选择 · 0 返回上一级'
export const modelLabelOf = (choice: ModelChoice): string => `${choice.provider}/${choice.model}`

/** 菜单里的编号，兼容全角数字和末尾句号。只在菜单开着的时候才消费纯数字。 */
export function parseChoice(text: string): number | undefined {
  const normalized = normalizeDigits(text).trim().replace(/[。．.]$/u, '')
  return /^\d{1,3}$/u.test(normalized) ? Number(normalized) : undefined
}

/** 限制预览长度，避免长记忆把菜单挤成多屏。完整内容仍保留在记忆库。 */
function preview(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim()
  const chars = Array.from(line)
  return chars.length > 100 ? chars.slice(0, 100).join('') + '…' : line
}

function pageCount(itemCount: number): number {
  return Math.max(1, Math.ceil(itemCount / MENU_PAGE_SIZE))
}

function currentPage(page: number, itemCount: number): number {
  return Math.min(Math.max(0, page), pageCount(itemCount) - 1)
}

function navigation(page: number, itemCount: number): string[] {
  const pages = pageCount(itemCount)
  return [
    `第 ${String(page + 1)}/${String(pages)} 页 · 1–7 选择`,
    `8  下一页${page + 1 < pages ? '' : '（没有下一页）'}`,
    `9  上一页${page > 0 ? '' : '（没有上一页）'}`,
    '0 返回上一级',
  ]
}

/** 每个面板保持标题、内容、操作提示三部分，直接作为一条微信消息发送。 */
export function renderMenu(panel: MenuPanel, view: MenuView, requestedPage = 0): string {
  if (panel === 'models') return renderModels(view, requestedPage)
  switch (panel) {
    case 'personas': {
      const page = currentPage(requestedPage, view.personaChoices.length)
      const lines = ['🎭 切换人格', `当前：${preview(view.personaName)}`, '选一个你喜欢的聊天风格。', '']
      if (!view.personaChoices.length) lines.push('还没有可选的人格。')
      view.personaChoices.slice(page * MENU_PAGE_SIZE, (page + 1) * MENU_PAGE_SIZE).forEach((choice, index) => {
        lines.push(`${index + 1}  ${preview(choice.name)}${choice.id === view.personaId ? '  ✓ 当前使用' : ''}`)
      })
      return [...lines, '', ...navigation(page, view.personaChoices.length)].join('\n')
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
        `2  换模型 · ${preview(view.modelLabel)}`,
        `3  个人记忆 · 已记下 ${view.memoryCount} 条`,
        `4  表情库 · ${view.stickerCount} 张可用`,
        '5  新对话 · 从新话题开始',
        '6  压缩对话 · 整理前面的内容',
        '',
        '回复数字选择 · 0 关闭',
        '菜单五分钟内有效，也可以直接继续聊天',
      ].join('\n')
  }
}

/** 模型页把「跟随默认」作为第一项，之后才是目录里的模型。 */
function renderModels(view: MenuView, requestedPage: number): string {
  const itemCount = view.modelChoices.length + 1
  const page = currentPage(requestedPage, itemCount)
  const lines = ['🤖 换模型', `当前：${preview(view.modelLabel)}`, '']
  if (view.modelChoices.length === 0) lines.push('宿主还没有可用的模型，可先到 DSH 里配置。', '')
  for (let offset = 0; offset < MENU_PAGE_SIZE; offset++) {
    const index = page * MENU_PAGE_SIZE + offset
    if (index >= itemCount) break
    if (index === 0) {
      lines.push(`1  跟随 DSH 默认${view.modelLabel === '跟随 DSH 默认' ? '  ✓' : ''}`)
      continue
    }
    const choice = view.modelChoices[index - 1]!
    const label = modelLabelOf(choice)
    lines.push(`${offset + 1}  ${label}${label === view.modelLabel ? '  ✓' : ''}`)
  }
  return [...lines, '', ...navigation(page, itemCount)].join('\n')
}

/** 子菜单的 0 返回上一级，主菜单的 0 关闭；分页面板的 8/9 固定用于翻页。 */
export function resolveChoice(panel: MenuPanel, choice: number, requestedPage = 0, itemCount = 0): MenuChoice {
  if (choice === 0) return panel === 'root'
    ? { kind: 'close' }
    : { kind: 'panel', panel: panel === 'clear-memory' ? 'memory' : 'root' }
  switch (panel) {
    case 'root':
      switch (choice) {
        case 1: return { kind: 'panel', panel: 'personas' }
        case 2: return { kind: 'panel', panel: 'models' }
        case 3: return { kind: 'panel', panel: 'memory' }
        case 4: return { kind: 'panel', panel: 'stickers' }
        case 5: return { kind: 'action', action: 'new-chat' }
        case 6: return { kind: 'action', action: 'compact' }
        default: return { kind: 'unknown' }
      }
    case 'models': return pagedChoice(choice, requestedPage, itemCount, 'model')
    case 'personas': return pagedChoice(choice, requestedPage, itemCount, 'persona')
    case 'memory': return choice === 1 ? { kind: 'panel', panel: 'clear-memory' } : { kind: 'unknown' }
    case 'clear-memory': return choice === 1 ? { kind: 'action', action: 'clear-memory' } : { kind: 'unknown' }
    default: return { kind: 'unknown' }
  }
}

function pagedChoice(choice: number, requestedPage: number, itemCount: number, kind: 'model' | 'persona'): MenuChoice {
  const page = currentPage(requestedPage, itemCount)
  if (choice === 8) return page + 1 < pageCount(itemCount) ? { kind: 'page', page: page + 1 } : { kind: 'unknown' }
  if (choice === 9) return page > 0 ? { kind: 'page', page: page - 1 } : { kind: 'unknown' }
  if (choice < 1 || choice > MENU_PAGE_SIZE) return { kind: 'unknown' }
  const index = page * MENU_PAGE_SIZE + choice - 1
  if (index >= itemCount) return { kind: 'unknown' }
  if (kind === 'persona') return { kind: 'action', action: `persona-${String(index + 1)}` }
  return { kind: 'action', action: index === 0 ? 'model-default' : `model-${String(index - 1)}` }
}

export type MenuChoice =
  | { kind: 'close' }
  | { kind: 'panel'; panel: MenuPanel }
  | { kind: 'page'; page: number }
  | { kind: 'action'; action: string }
  | { kind: 'unknown' }
