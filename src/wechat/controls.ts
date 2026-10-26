/** 微信控制消息：中文命令和数字菜单。普通对话投递、轮询与模型事件由 Channel 管理。 */
import { DEFAULT_REPLY_PLAN, resolvePlan, type ReplyPlan } from '../reply/bubbles.ts'
import type { ReplyQueue } from '../reply/queue.ts'
import { PersonaStore } from '../persona/store.ts'
import { DEFAULT_CHAT_SETTINGS, type ChatSettings, type ChatSettingsStore } from '../chat/settings.ts'
import type { PeerGenerations } from '../chat/generations.ts'
import type { PeerMemory } from '../chat/memory.ts'
import type { StickerLibrary } from '../stickers/library.ts'
import { normalizeStickerName } from '../stickers/markers.ts'
import { MENU_TTL_MS, parseChoice, renderMenu, resolveChoice, type MenuPanel, type MenuView } from './menu.ts'
import { formatAgo, formatHelp, formatNewChat, formatPersona, formatStatus, formatStyle, formatUnknown } from './commands.ts'

export interface ChatControlsOptions {
  personas: PersonaStore
  defaultPersona: string
  settings?: ChatSettingsStore
  generations?: PeerGenerations
  permissionLabel?: string
  memory?: Pick<PeerMemory, 'get' | 'clear'>
  modelLabel?: string
  stickers?: Pick<StickerLibrary, 'names' | 'adoptLatest'>
  sendSticker?: (peerId: string, name: string, token: string | undefined) => Promise<boolean>
  replies: ReplyQueue
  report?: (line: string, detail?: unknown) => void
  now?: () => number
  planFor: (peerId: string) => ReplyPlan | undefined
  setPlan: (peerId: string, plan: ReplyPlan) => void
  contextTokenFor: (peerId: string) => string | undefined
  lastSeen: (peerId: string) => number | undefined
  turnsFor: (peerId: string) => number
  cancelTurn: (peerId: string, generation: number) => Promise<boolean>
}

export class ChatControls {
  private readonly options: ChatControlsOptions
  private readonly menus = new Map<string, { panel: MenuPanel; at: number }>()

  constructor(options: ChatControlsOptions) { this.options = options }

  dispose(): void { this.menus.clear() }

  /** 打开设置卡片（`/menu`）。 */
  async openMenu(peerId: string, panel: MenuPanel = 'root', contextToken?: string): Promise<void> {
    this.menus.set(peerId, { panel, at: (this.options.now ?? Date.now)() })
    const view = await this.menuView(peerId)
    await this.answer(peerId, renderMenu(panel, view), contextToken)
  }

  /**
   * 把一条消息当作卡片点击。
   *
   * @returns 被消费掉就 true；不是点击（或卡片过期）时 false，消息照常处理。
   */
  async consumeMenu(peerId: string, text: string): Promise<boolean> {
    const state = this.menus.get(peerId)
    if (state === undefined) return false
    const now = (this.options.now ?? Date.now)()
    if (now - state.at > MENU_TTL_MS) {
      this.menus.delete(peerId)
      return false
    }
    const choice = parseChoice(text)
    if (choice === undefined) {
      // 用户开始说别的事：收起卡片，别把这句话吞掉。
      this.menus.delete(peerId)
      return false
    }
    this.menus.delete(peerId)
    await this.applyChoice(peerId, state.panel, choice, this.options.contextTokenFor(peerId))
    return true
  }

  private async applyChoice(peerId: string, panel: MenuPanel, choice: number, contextToken: string | undefined): Promise<void> {
    const resolved = resolveChoice(panel, choice)
    if (resolved.kind === 'close') {
      await this.answer(peerId, '好，设置先收起来。发“菜单”再打开。', contextToken)
      return
    }
    if (resolved.kind === 'panel') {
      await this.openMenu(peerId, resolved.panel, contextToken)
      return
    }
    if (resolved.kind === 'unknown') {
      await this.openMenu(peerId, panel, contextToken)
      return
    }

    const settings = this.options.settings
    const snapshot = await this.ensureSnapshot()
    const current = await this.settingsFor(peerId)
    const card = PersonaStore.resolve(current.personaId ?? this.options.defaultPersona, snapshot)

    switch (resolved.action) {
      case 'new-chat': {
        if (this.options.generations === undefined) {
          await this.answer(peerId, '这个部署没有开启多段对话。', contextToken)
          return
        }
        await this.options.generations.bump(peerId)
        await this.answer(peerId, '开了新对话：之前的内容还在记录里，但这轮开始不再带进上下文。', contextToken)
        return
      }
      case 'sticker-library': {
        // 只是展示：表情的发送仍由模型在回复里写 [表情:名字] 决定。
        const names = await this.options.stickers?.names(peerId) ?? []
        await this.answer(peerId, names.length === 0 ? '表情库是空的：把图片放进 stickers/ 目录就能用。' : `表情库（${String(names.length)} 张）：\n${names.join('、')}`, contextToken)
        return
      }
      case 'clear-memory': {
        await this.options.memory?.clear(peerId)
        await this.answer(peerId, '记忆清空了。', contextToken)
        return
      }
      case 'split-sentence':
      case 'split-paragraph':
      case 'split-none': {
        if (settings === undefined) break
        const split: ChatSettings['split'] =
          resolved.action === 'split-sentence' ? 'sentence' : resolved.action === 'split-paragraph' ? 'paragraph' : 'none'
        const next = { ...current, split }
        await settings.save(peerId, next)
        this.options.setPlan(peerId, resolvePlan(card, next))
        await this.answer(peerId, `分条：按${split === 'sentence' ? '句子' : split === 'none' ? '不切' : '段落'}。`, contextToken)
        return
      }
      case 'max-chars-200': {
        if (settings === undefined) break
        const next = { ...current, maxChars: 200 }
        await settings.save(peerId, next)
        this.options.setPlan(peerId, resolvePlan(card, next))
        await this.answer(peerId, '每条最多 200 字。', contextToken)
        return
      }
      case 'style-reset': {
        if (settings === undefined) break
        const next = { ...current, maxChars: undefined, split: undefined }
        await settings.save(peerId, next)
        this.options.setPlan(peerId, resolvePlan(card, next))
        await this.answer(peerId, '已恢复人格卡的分条方式。', contextToken)
        return
      }
      case 'model-default': {
        // 目前只能跟随桌面端：DSH 没有给插件「换某个会话的模型」的口子。
        await this.answer(peerId, '模型跟随桌面端的默认选择，聊天里暂时改不了。', contextToken)
        return
      }
      default: {
        const match = /^persona-(\d+)$/u.exec(resolved.action)
        if (match !== null && settings !== undefined) {
          const index = Number(match[1]) - 1
          const picked = [...snapshot.personas.values()][index]
          if (picked !== undefined) {
            await settings.save(peerId, { ...current, personaId: picked.card.id })
            await this.answer(peerId, `已切到「${picked.card.name}」，下一轮生效。`, contextToken)
            return
          }
        }
      }
    }
    // 走到这里说明没执行任何动作：把当前面板再发一次，让用户重选。
    await this.openMenu(peerId, panel, contextToken)
  }

  /** 组装卡片展示所需的当前状态。 */
  private async menuView(peerId: string): Promise<MenuView> {
    const snapshot = await this.ensureSnapshot()
    const settings = await this.settingsFor(peerId)
    const card = PersonaStore.resolve(settings.personaId ?? this.options.defaultPersona, snapshot)
    const plan = resolvePlan(card, settings)
    const names = await this.options.stickers?.names(peerId) ?? []
    return {
      personaId: card.id,
      personaName: card.name,
      personaChoices: [...snapshot.personas.values()].map(persona => ({ id: persona.card.id, name: persona.card.name })),
      model: this.options.modelLabel ?? '',
      memoryCount: this.options.memory?.get(peerId).length ?? 0,
      memoryFacts: this.options.memory?.get(peerId) ?? [],
      maxChars: plan.softChars,
      split: plan.splitMode,
      overridden: settings.maxChars !== undefined || settings.split !== undefined,
      canSwitchModel: false,
      stickerCount: names.length,
    }
  }

  /** 一条纯文本回复（走正常队列，限流/分条都复用）。 */
  private async answer(peerId: string, text: string, contextToken: string | undefined): Promise<void> {
    const plan = this.options.planFor(peerId) ?? DEFAULT_REPLY_PLAN
    const started = (this.options.now ?? Date.now)()
    await this.options.replies.enqueue(peerId, text, contextToken, { ...plan, splitMode: 'none' }, { immediate: true })
    this.options.report?.(`卡片已发出（${String((this.options.now ?? Date.now)() - started)}ms）`)
  }

  /** 读这个聊天的设置；没有设置仓库时用默认值。 */
  private async settingsFor(peerId: string): Promise<ChatSettings> {
    return this.options.settings === undefined ? DEFAULT_CHAT_SETTINGS : await this.options.settings.get(peerId)
  }


  private async ensureSnapshot() {
    return await this.options.personas.snapshot()
  }

  /**
   * 执行一条内置命令。
   *
   * 命令的回复走和模型回复同一条队列：这样限流、切分、失败提示都自动复用。
   */
  async execute(peerId: string, command: { name: string; args: string[] }, generation: number, contextToken: string | undefined): Promise<void> {
    const reply = (text: string): void => {
      const started = (this.options.now ?? Date.now)()
      void this.options.replies.enqueue(peerId, text, contextToken, this.options.planFor(peerId), { immediate: true })
        .then(() => this.options.report?.(`命令 /${command.name} 的回复已发出（${String((this.options.now ?? Date.now)() - started)}ms）`))
    }

    switch (command.name) {
      case 'help':
        reply(formatHelp())
        return

      case 'new': {
        if (this.options.generations === undefined) {
          reply('这个部署没有开启多段对话。')
          return
        }
        // 旧会话不 dispose：它的历史还在，只是这个聊天不再往那儿投递。
        const next = await this.options.generations.bump(peerId)
        reply(formatNewChat(next))
        this.options.report?.('开了新对话', { peerId, generation: next })
        return
      }

      case 'status': {
        const snapshot = await this.ensureSnapshot()
        const settings = this.options.settings === undefined ? DEFAULT_CHAT_SETTINGS : await this.options.settings.get(peerId)
        const card = PersonaStore.resolve(settings.personaId ?? this.options.defaultPersona, snapshot)
        const last = this.options.lastSeen(peerId)
        const now = (this.options.now ?? Date.now)()
        reply(formatStatus({
          personaId: card.id,
          personaName: card.name,
          generation,
          turns: this.options.turnsFor(peerId),
          permission: this.options.permissionLabel ?? '未知',
          ...(last === undefined ? {} : { lastActive: formatAgo(now - last) }),
        }))
        return
      }

      case 'persona': {
        const snapshot = await this.ensureSnapshot()
        const choices = [...snapshot.personas.values()].map(persona => ({ id: persona.card.id, name: persona.card.name }))
        const settings = this.options.settings
        if (settings === undefined) {
          reply('这个部署没有可写的聊天设置。')
          return
        }
        if (command.args.length === 0) {
          const current = (await settings.get(peerId)).personaId ?? this.options.defaultPersona
          reply(formatPersona(current, choices))
          return
        }
        const wanted = command.args[0] ?? ''
        const found = choices.find(choice => choice.id === wanted)
        if (found === undefined) {
          reply(`没有「${wanted}」这张人格卡。\n\n${formatPersona(this.options.defaultPersona, choices)}`)
          return
        }
        const current = await settings.get(peerId)
        await settings.save(peerId, { ...current, personaId: found.id })
        reply(formatPersona(found.id, choices, found))
        return
      }

      case '表情': {
        const sub = command.args[0] ?? ''
        if (sub === '收' || sub === '收下') {
          const name = normalizeStickerName(command.args.slice(1).join(' '))
          if (name === undefined) {
            reply('用法：/表情 收 名字（名字不超过 24 字，不能带空格和方括号）')
            return
          }
          if (this.options.stickers === undefined) {
            reply('这个部署没有表情库目录。')
            return
          }
          const saved = await this.options.stickers.adoptLatest(peerId, name)
          reply(saved === undefined
            ? '最近没有可收的图：先发一张图给我，再说 /表情 收 名字。'
            : `收好了：${saved}。之后它会用 [表情:${name}] 发这张。`)
          return
        }
        if (sub === '发' || sub === '发送') {
          const name = normalizeStickerName(command.args.slice(1).join(' '))
          if (name === undefined) {
            reply('用法：/表情 发 名字')
            return
          }
          const sent = await this.options.sendSticker?.(peerId, name, contextToken)
          reply(sent === true ? `已发出「${name}」。` : `没发出去：表情库里没有「${name}」。发 /表情 看有哪些。`)
          return
        }
        const names = await this.options.stickers?.names(peerId) ?? []
        reply(names.length === 0
          ? '表情库是空的。把图片放进 stickers/ 目录（支持 png/jpg/gif/webp），或先发图再说「/表情 收 名字」。'
          : `表情库（${String(names.length)} 张）：\n${names.join('、')}\n\n发 /表情 发 名字 可以直接发一张。`)
        return
      }

      case 'menu': {
        await this.openMenu(peerId, 'root', contextToken)
        return
      }

      case 'stop': {
        // 打断跑偏的一轮：微信里没有别的办法让它停下来。
        const cancelled = await this.options.cancelTurn(peerId, generation)
        reply(cancelled ? '已打断这一轮。' : '现在没有在跑的活。')
        return
      }

      case 'style': {
        // 分条方式以前只能手改 settings.json，等于没有；这条命令是它的入口。
        const settings = this.options.settings
        if (settings === undefined) {
          reply('这个部署没有可写的聊天设置。')
          return
        }
        const snapshot = await this.ensureSnapshot()
        const current = await settings.get(peerId)
        const card = PersonaStore.resolve(current.personaId ?? this.options.defaultPersona, snapshot)
        const plan = resolvePlan(card, current)
        const wanted = command.args[0]?.toLowerCase()

        if (wanted === undefined) {
          reply(formatStyle({
            maxChars: plan.softChars,
            split: plan.splitMode,
            overridden: current.maxChars !== undefined || current.split !== undefined,
          }))
          return
        }

        if (wanted === 'reset') {
          const next = { ...current, maxChars: undefined, split: undefined }
          await settings.save(peerId, next)
          this.options.setPlan(peerId, resolvePlan(card, next))
          reply(`已恢复人格卡的分条方式：每条约 ${String(card.reply.maxChars)} 字，按${card.reply.split === 'sentence' ? '句子' : card.reply.split === 'none' ? '不切' : '段落'}切。`)
          return
        }

        if (wanted === 'sentence' || wanted === 'paragraph' || wanted === 'none') {
          const mode: ChatSettings['split'] = wanted
          const next = { ...current, split: mode }
          await settings.save(peerId, next)
          this.options.setPlan(peerId, resolvePlan(card, next))
          reply(`分条改成按${wanted === 'sentence' ? '句子' : wanted === 'none' ? '不切' : '段落'}切，下一条生效。`)
          return
        }

        const chars = Number(wanted)
        if (!Number.isFinite(chars)) {
          reply('用法：分条 160（改字数）、分条 按句、分条 不切、分条 恢复。')
          return
        }
        const clamped = Math.round(Math.min(4_096, Math.max(20, chars)))
        const next = { ...current, maxChars: clamped }
        await settings.save(peerId, next)
        this.options.setPlan(peerId, resolvePlan(card, next))
        reply(`每条最多 ${String(clamped)} 字，下一条生效。`)
        return
      }

      default:
        reply(formatUnknown(command.name))
    }
  }

}
