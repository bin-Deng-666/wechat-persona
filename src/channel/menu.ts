/**
 * 微信里的「设置卡片」。
 *
 * 微信没有按钮组件——iLink 机器人只能发文本/图片/文件，发不了带按钮的卡片。
 * 所以这里用最接近「点一下」的形式：一张编号卡片，回一个数字就是一次点击。
 *
 * 两个纪律：
 * - **卡片是临时的**：5 分钟没理就失效，免得三天后回一个「3」误触设置。
 * - **数字只在卡片有效时被消费**：其他消息照常进模型，不会因为一张卡片
 *   把「3 点开会」这种正常聊天吞掉。
 *
 * @module wechat-persona/channel/menu
 */

import { normalizeDigits } from '../bridge/text.ts'

/** 卡片面板。 */
export type MenuPanel = 'root' | 'personas' | 'model' | 'memory' | 'style'

/** 渲染卡片需要的当前状态。 */
export interface MenuView {
  personaId: string
  personaName: string
  personaChoices: readonly { id: string; name: string }[]
  /** 当前模型 id；未知时为空串。 */
  model: string
  memoryCount: number
  /** 记忆预览（换行分隔）；面板里最多展示几条。 */
  memoryFacts: readonly string[]
  maxChars: number
  split: 'paragraph' | 'sentence' | 'none'
  /** 分条设置是不是这个聊天自己设的。 */
  overridden: boolean
  /** 这个宿主能不能切模型（不能就只展示）。 */
  canSwitchModel: boolean
  /** 表情库里有几张。 */
  stickerCount: number
}

/** 卡片有效期。 */
export const MENU_TTL_MS = 5 * 60_000

const SPLIT_LABEL: Record<MenuView['split'], string> = {
  paragraph: '按段落',
  sentence: '按句子',
  none: '不切',
}

/**
 * 把一句回复解析成卡片选项。
 *
 * @param text - 用户发的原文。
 * @returns 0–9 的选项号；不是单个数字时 undefined。
 */
export function parseChoice(text: string): number | undefined {
  // 中文输入法下很容易打出全角「１」；它不是另一个选项，就是 1。
  const normalized = normalizeDigits(text).trim().replace(/[。．.]$/u, '')
  if (!/^\d$/u.test(normalized)) return undefined
  return Number(normalized)
}

/**
 * 渲染一张卡片。
 *
 * @param panel - 当前面板。
 * @param view - 当前状态。
 * @returns 可直接发送的纯文本。
 */
export function renderMenu(panel: MenuPanel, view: MenuView): string {
  switch (panel) {
    case 'personas': {
      const lines = ['人格', '']
      // 最多 9 个：选项只有一位数字。
      view.personaChoices.slice(0, 9).forEach((choice, index) => {
        const current = choice.id === view.personaId ? ' ✓' : ''
        lines.push(`${String(index + 1)}  ${choice.name}（${choice.id}）${current}`)
      })
      lines.push('', '0  返回')
      return lines.join('\n')
    }

    case 'model': {
      const lines = ['模型', '', `当前：${view.model === '' ? '未知' : view.model}`]
      if (view.canSwitchModel) {
        lines.push('', '1  切到默认模型（跟随桌面端设置）')
      } else {
        lines.push('', '这个宿主不支持在聊天里换模型，去桌面端的模型选择器改。')
      }
      lines.push('', '0  返回')
      return lines.join('\n')
    }

    case 'memory': {
      const lines = ['记忆', '']
      if (view.memoryCount === 0) {
        lines.push('还没记住什么。说「记住：…」我就能记下来。')
      } else {
        lines.push(`已记 ${String(view.memoryCount)} 条：`)
        for (const fact of view.memoryFacts.slice(0, 8)) lines.push(`· ${fact}`)
        if (view.memoryCount > 8) lines.push(`…还有 ${String(view.memoryCount - 8)} 条`)
      }
      lines.push('', '1  清空记忆', '0  返回')
      return lines.join('\n')
    }

    case 'style': {
      return [
        '分条',
        '',
        `当前：每条约 ${String(view.maxChars)} 字，${SPLIT_LABEL[view.split]}${view.overridden ? '（聊天设置）' : '（人格卡）'}`,
        '',
        '1  按句子切',
        '2  按段落切',
        '3  不切（整条发）',
        '4  每条约 200 字',
        '5  恢复人格卡',
        '',
        '0  返回',
      ].join('\n')
    }

    default: {
      return [
        '设置',
        '',
        `1  人格 · ${view.personaName}`,
        `2  模型 · ${view.model === '' ? '未知' : view.model}`,
        `3  记忆 · ${view.memoryCount === 0 ? '空' : `${String(view.memoryCount)} 条`}`,
        `4  分条 · ${String(view.maxChars)} 字 / ${SPLIT_LABEL[view.split]}`,
        `5  新对话${view.stickerCount > 0 ? `\n6  表情库 · ${String(view.stickerCount)} 张` : ''}`,
        '',
        '0  关闭（5 分钟内回复编号）',
      ].join('\n')
    }
  }
}

/**
 * 卡片点击之后落到哪个面板/动作。
 *
 * @param panel - 当前面板。
 * @param choice - 选项号。
 * @returns 下一个面板（`'close'` 表示收起），或者要执行的动作名。
 */
export function resolveChoice(panel: MenuPanel, choice: number): MenuChoice {
  if (choice === 0) return { kind: 'close' }

  switch (panel) {
    case 'root':
      switch (choice) {
        case 1: return { kind: 'panel', panel: 'personas' }
        case 2: return { kind: 'panel', panel: 'model' }
        case 3: return { kind: 'panel', panel: 'memory' }
        case 4: return { kind: 'panel', panel: 'style' }
        case 5: return { kind: 'action', action: 'new-chat' }
        case 6: return { kind: 'action', action: 'sticker-library' }
        default: return { kind: 'unknown' }
      }
    case 'personas':
      return { kind: 'action', action: `persona-${String(choice)}` }
    case 'model':
      return choice === 1 ? { kind: 'action', action: 'model-default' } : { kind: 'unknown' }
    case 'memory':
      return choice === 1 ? { kind: 'action', action: 'clear-memory' } : { kind: 'unknown' }
    case 'style':
      switch (choice) {
        case 1: return { kind: 'action', action: 'split-sentence' }
        case 2: return { kind: 'action', action: 'split-paragraph' }
        case 3: return { kind: 'action', action: 'split-none' }
        case 4: return { kind: 'action', action: 'max-chars-200' }
        case 5: return { kind: 'action', action: 'style-reset' }
        default: return { kind: 'unknown' }
      }
    default:
      return { kind: 'unknown' }
  }
}

/** 点击结果。 */
export type MenuChoice =
  | { kind: 'close' }
  | { kind: 'panel'; panel: MenuPanel }
  | { kind: 'action'; action: string }
  | { kind: 'unknown' }
