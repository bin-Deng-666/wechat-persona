/** 微信设置菜单与内置命令执行，数据直接通过各领域仓库读写。 */
import { DEFAULT_REPLY_PLAN, type ReplyPlan } from '../reply/bubbles.ts'
import type { ReplyQueue, ReplyScope } from '../reply/queue.ts'
import { PersonaStore } from '../persona/store.ts'
import { DEFAULT_CHAT_SETTINGS, type ChatSettings, type ChatSettingsStore } from '../chat/settings.ts'
import type { PeerGenerations } from '../chat/generations.ts'
import type { PeerMemory } from '../memory/store.ts'
import type { StickerLibrary } from '../stickers/library.ts'
import { normalizeStickerName } from '../stickers/markers.ts'
import { MENU_TTL_MS, modelLabelOf, parseChoice, renderMenu, resolveChoice, type MenuPanel, type ModelChoice, type MenuView } from './menu.ts'
import { formatAgo, formatCompact, formatHelp, formatModelSwitch, formatNewChat, formatPersona, formatStatus, formatUnknown } from './commands.ts'
import type { CompactOutcome } from '../dsh/compaction.ts'

/** 宿主模型目录：顺序与 DSH 选择器一致，`current` 是宿主的默认选择。 */
export interface ModelCatalog {
  choices: readonly ModelChoice[]
  current?: ModelChoice
}

export interface ChatControlsOptions {
  personas: PersonaStore
  defaultPersona: string
  /** 宿主当前的模型目录；缺失时菜单不提供换模型。 */
  catalog?: () => Promise<ModelCatalog | undefined>
  settings?: ChatSettingsStore
  generations?: PeerGenerations
  permissionLabel?: string
  memory?: Pick<PeerMemory, 'get' | 'clear' | 'legacy'>
  stickers?: Pick<StickerLibrary, 'names' | 'adoptLatest'>
  sendSticker?: (peerId: string, name: string, token: string | undefined) => Promise<boolean | 'failed' | 'unknown'>
  replies: ReplyQueue
  scopeFor?: (peerId: string) => ReplyScope | undefined
  report?: (line: string, detail?: unknown) => void
  now?: () => number
  planFor: (peerId: string) => ReplyPlan | undefined
  contextTokenFor: (peerId: string) => string | undefined
  /** 长操作交回通道跟踪，让接收循环继续响应「停止」。 */
  runBackground?: (task: Promise<void>) => void
  lastSeen: (peerId: string) => number | undefined
  turnsFor: (peerId: string) => number
  cancelTurn: (peerId: string, generation: number) => Promise<boolean>
  retryDelivery: (peerId: string) => Promise<'idle' | 'retried' | 'failed'>
  /** 在现有会话里切换模型；宿主不支持时返回 false，由调用方回退到新会话。 */
  selectModel?: (peerId: string, generation: number, choice: ModelChoice) => Promise<boolean>
  newConversation: (peerId: string) => Promise<number>
  /** 压缩当前对话；缺失表示这个宿主没有压缩能力。 */
  compactConversation?: (peerId: string, generation: number) => Promise<CompactOutcome>
}

export class ChatControls {
  private readonly options: ChatControlsOptions
  /** 每个联系人的菜单状态与页码；只在有效期内消费数字。 */
  private readonly menus = new Map<string, { panel: MenuPanel; page: number; at: number }>()

  constructor(options: ChatControlsOptions) { this.options = options }

  dispose(): void { this.menus.clear() }
  closeMenu(peerId: string): void { this.menus.delete(peerId) }

  /** 打开设置菜单。 */
  async openMenu(peerId: string, panel: MenuPanel = 'root', contextToken?: string, page = 0): Promise<void> {
    this.menus.set(peerId, { panel, page, at: (this.options.now ?? Date.now)() })
    await this.answer(peerId, renderMenu(panel, await this.menuView(peerId), page), contextToken)
  }

  /**
   * 把一条消息当作菜单点击。
   *
   * @returns 被消费掉就 true；不是点击（或菜单过期）时 false，消息照常处理。
   */
  async consumeMenu(peerId: string, text: string, generation = 0): Promise<boolean> {
    const state = this.menus.get(peerId)
    if (state === undefined) return false
    const now = (this.options.now ?? Date.now)()
    if (now - state.at > MENU_TTL_MS) {
      this.menus.delete(peerId)
      return false
    }
    const choice = text.trim() === '返回' ? 0 : text.trim() === '关闭' ? 0 : parseChoice(text)
    if (choice === undefined) {
      // 用户开始说别的事：收起菜单，别把这句话吞掉。
      this.menus.delete(peerId)
      return false
    }
    this.menus.delete(peerId)
    const panel = text.trim() === '关闭' ? 'root' : state.panel
    const resolved = resolveChoice(panel, choice, state.page, await this.menuItemCount(peerId, panel))
    if (resolved.kind === 'action' && resolved.action === 'compact') {
      const task = this.execute(peerId, { name: 'compact', args: [] }, generation, this.options.contextTokenFor(peerId))
      if (this.options.runBackground) this.options.runBackground(task)
      else await task
    } else {
      await this.applyChoice(peerId, panel, choice, this.options.contextTokenFor(peerId), state.page, generation)
    }
    return true
  }

  private async applyChoice(peerId: string, panel: MenuPanel, choice: number, contextToken: string | undefined, page: number, generation = 0): Promise<void> {
    const resolved = resolveChoice(panel, choice, page, await this.menuItemCount(peerId, panel))
    if (resolved.kind === 'close') {
      await this.answer(peerId, '设置已关闭，我们继续聊。', contextToken)
      return
    }
    if (resolved.kind === 'panel') {
      await this.openMenu(peerId, resolved.panel, contextToken)
      return
    }
    if (resolved.kind === 'page') {
      await this.openMenu(peerId, panel, contextToken, resolved.page)
      return
    }
    if (resolved.kind === 'unknown') {
      await this.openMenu(peerId, panel, contextToken, page)
      return
    }

    const settings = this.options.settings
    if (resolved.action === 'model-default') {
      await this.applyDefaultModel(peerId, contextToken, generation)
      return
    }

    const modelPicked = /^model-(\d+)$/u.exec(resolved.action)
    if (modelPicked !== null) {
      await this.applyModel(peerId, Number(modelPicked[1]), contextToken, page, generation)
      return
    }

    switch (resolved.action) {
      case 'new-chat': {
        if (this.options.generations === undefined) {
          await this.answer(peerId, '这个部署没有开启多段对话。', contextToken)
          return
        }
        const next = await this.options.newConversation(peerId)
        await this.answer(peerId, formatNewChat(next), contextToken)
        return
      }
      case 'clear-memory': {
        if (!this.options.memory) {
          await this.answer(peerId, '这个部署未启用个人记忆。', contextToken)
          return
        }
        await this.options.memory.clear(peerId)
        await this.answer(peerId, '✓ 记忆已清空\n之后有需要记住的事，再告诉我就好。', contextToken)
        return
      }
      default: {
        const match = /^persona-(\d+)$/u.exec(resolved.action)
        if (match !== null && settings !== undefined) {
          const index = Number(match[1]) - 1
          const picked = [...(await this.ensureSnapshot()).personas.values()][index]
          if (picked !== undefined) {
            await settings.update(peerId, latest => ({ ...latest, personaId: picked.card.id }))
            await this.answer(peerId, formatPersona(picked.card.id, [], picked.card), contextToken)
            return
          }
        }
      }
    }
    // 走到这里说明没执行任何动作：把当前面板再发一次，让用户重选。
    await this.openMenu(peerId, panel, contextToken, page)
  }

  /** 平铺目录里的第 n 个模型；`provider/model` 原样交给宿主。 */
  private async applyModel(peerId: string, index: number, contextToken: string | undefined, page: number, generation = 0): Promise<void> {
    const catalog = await this.options.catalog?.()
    const picked = catalog?.choices[index]
    const settings = this.options.settings
    if (picked === undefined || settings === undefined) {
      await this.openMenu(peerId, 'models', contextToken, page)
      return
    }
    const label = modelLabelOf(picked)
    const current = await this.settingsFor(peerId)
    const effective = current.model ?? catalog?.current
    if (effective !== undefined && modelLabelOf(effective) === label) {
      await this.answer(peerId, `现在用的就是 ${label}\n继续聊就行。`, contextToken)
      return
    }
    await settings.update(peerId, latest => ({ ...latest, model: picked }))
    // 优先在现有会话里切换：宿主支持热切时，上下文不用丢。
    if (this.options.selectModel !== undefined && await this.options.selectModel(peerId, generation, picked)) {
      await this.answer(peerId, formatModelSwitch(label), contextToken)
      return
    }
    // 旧宿主只能在建会话时定模型：明确告知要换一段会话，而不是假装上下文还在。
    if (this.options.generations === undefined) {
      await this.answer(peerId, formatModelSwitch(label), contextToken)
      return
    }
    const next = await this.options.newConversation(peerId)
    await this.answer(peerId, formatModelSwitch(label, next), contextToken)
  }

  /** 清除联系人覆盖即可；下一条消息由协调器读取宿主当前默认，现有会话与上下文都保留。 */
  private async applyDefaultModel(peerId: string, contextToken: string | undefined, generation = 0): Promise<void> {
    if (this.options.settings === undefined) {
      await this.openMenu(peerId, 'models', contextToken)
      return
    }
    const current = (await this.options.catalog?.())?.current
    await this.options.settings.update(peerId, latest => {
      const next = { ...latest }
      delete next.model
      return next
    })
    // 已有会话不会自动跟随默认：能热切就切到默认，否则如实说明只对下一段会话生效。
    const applied = current !== undefined && this.options.selectModel !== undefined
      ? await this.options.selectModel(peerId, generation, current)
      : false
    if (applied) {
      await this.answer(peerId, '✓ 已设为跟随 DSH 默认\n下一条消息就会使用 DSH 当前的默认模型，聊天上下文继续保留。', contextToken)
      return
    }
    await this.answer(peerId, '✓ 已清除联系人的模型设置\n当前会话仍沿用原模型；新的默认会在下一段会话生效。', contextToken)
  }

  /** 分页只需条目数；页码与菜单生命周期一起由这里管理。 */
  private async menuItemCount(peerId: string, panel: MenuPanel): Promise<number> {
    if (panel === 'personas') return (await this.ensureSnapshot()).personas.size
    if (panel === 'models') return ((await this.options.catalog?.())?.choices.length ?? 0) + 1
    return 0
  }

  /** 组装菜单展示所需的当前状态。 */
  private async menuView(peerId: string): Promise<MenuView> {
    const snapshot = await this.ensureSnapshot()
    const settings = await this.settingsFor(peerId)
    const card = PersonaStore.resolve(settings.personaId ?? this.options.defaultPersona, snapshot)
    const names = await this.options.stickers?.names(peerId) ?? []
    const memories = this.options.memory?.get(peerId) ?? []
    const legacy = this.options.memory?.legacy(peerId) ?? []
    const catalog = await this.options.catalog?.()
    const current = settings.model ?? catalog?.current
    return {
      personaId: card.id,
      personaName: card.name,
      personaChoices: [...snapshot.personas.values()].map(persona => ({ id: persona.card.id, name: persona.card.name })),
      memoryCount: memories.length + legacy.length,
      memoryFacts: [...memories.map(memory => `[${memory.type}] ${memory.content}`), ...legacy.map(text => `[旧版未核实] ${text}`)],
      stickerCount: names.length,
      stickerNames: names,
      modelChoices: catalog?.choices ?? [],
      modelLabel: current === undefined ? '跟随 DSH 默认' : modelLabelOf(current),
    }
  }

  /** 一条纯文本回复（走正常队列，限流与失败提示都复用）。 */
  private async answer(peerId: string, text: string, contextToken: string | undefined): Promise<void> {
    const plan = this.options.planFor(peerId) ?? DEFAULT_REPLY_PLAN
    const started = (this.options.now ?? Date.now)()
    // 菜单整条发送，避免人格卡的分条设置打散选项。
    void this.options.replies.enqueue(peerId, text, contextToken, { ...plan, splitMode: 'none', softChars: 4096 }, { immediate: true, scope: this.options.scopeFor?.(peerId) })
      .then(outcome => this.options.report?.(`菜单投递：${outcome.status}（${String((this.options.now ?? Date.now)() - started)}ms）`))
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
    const scope = this.options.scopeFor?.(peerId)
    const reply = (text: string, currentScope?: ReplyScope): void => {
      const started = (this.options.now ?? Date.now)()
      void this.options.replies.enqueue(peerId, text, contextToken, { ...(this.options.planFor(peerId) ?? DEFAULT_REPLY_PLAN), splitMode: 'none', softChars: 4096 }, { immediate: true, scope: currentScope ?? scope })
        .then(outcome => this.options.report?.(`命令 /${command.name} 投递：${outcome.status}（${String((this.options.now ?? Date.now)() - started)}ms）`))
    }

    switch (command.name) {
      case 'help':
        reply(formatHelp())
        return

      case 'menu': {
        await this.openMenu(peerId, 'root', contextToken)
        return
      }

      case 'memory': {
        await this.openMenu(peerId, 'memory', contextToken)
        return
      }

      case 'new': {
        if (this.options.generations === undefined) {
          reply('这个部署没有开启多段对话。')
          return
        }
        // 旧会话不 dispose：它的历史还在，只是这个聊天不再往那儿投递。
        const next = await this.options.newConversation(peerId)
        reply(formatNewChat(next), this.options.scopeFor?.(peerId))
        this.options.report?.('开了新对话', { peerId, generation: next })
        return
      }

      case 'compact': {
        // 压缩要和正在跑的一轮串行化，宿主空闲时才会真的执行；结论必须回一句。
        try {
          const outcome = this.options.compactConversation === undefined
            ? { kind: 'unavailable' as const }
            : await this.options.compactConversation(peerId, generation)
          reply(formatCompact(outcome))
        } catch (error) {
          this.options.report?.('压缩未完成', { peerId, error: String(error) })
          reply('压缩未完成，可以稍后再试。')
        }
        return
      }

      case 'status': {
        const snapshot = await this.ensureSnapshot()
        const settings = await this.settingsFor(peerId)
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
          await this.openMenu(peerId, 'personas', contextToken)
          return
        }
        const wanted = command.args[0] ?? ''
        const found = choices.find(choice => choice.id === wanted)
        if (found === undefined) {
          reply(`没有「${wanted}」这张人格卡。发「设置」从菜单里选。`)
          return
        }
        await settings.update(peerId, latest => ({ ...latest, personaId: found.id }))
        reply(formatPersona(found.id, choices, found))
        return
      }

      case '表情': {
        const sub = command.args[0] ?? ''
        if (sub === '') {
          await this.openMenu(peerId, 'stickers', contextToken)
          return
        }
        if (sub === '收' || sub === '收下') {
          const name = normalizeStickerName(command.args.slice(1).join(' '))
          if (name === undefined) {
            reply('用法：表情 收 名字（名字不超过 24 字，不能带空格和方括号）')
            return
          }
          if (this.options.stickers === undefined) {
            reply('这个部署没有表情库目录。')
            return
          }
          const saved = await this.options.stickers.adoptLatest(peerId, name)
          reply(saved === undefined
            ? '还没有可以收藏的图片。\n先发一张图，再发送「表情 收 名字」。'
            : `✓ 已收藏「${name}」\n想发这张图，发送「表情 发 ${name}」。`)
          return
        }
        if (sub === '发' || sub === '发送') {
          const name = normalizeStickerName(command.args.slice(1).join(' '))
          if (name === undefined) {
            reply('用法：表情 发 名字')
            return
          }
          const sent = await this.options.sendSticker?.(peerId, name, contextToken)
          reply(sent === true ? `已发出「${name}」。`
            : sent === false || sent === undefined ? `表情库里没有「${name}」。发「设置」看有哪些。`
              : sent === 'unknown' ? `「${name}」的发送结果未确认，稍后发送「重试」可以再试。`
                : `「${name}」没有发送成功，可以稍后发送「重试」。`)
          return
        }
        const names = await this.options.stickers?.names(peerId) ?? []
        reply(names.length === 0
          ? '表情库是空的。把图片放进 stickers/ 目录（支持 png/jpg/gif/webp），或先发图再说「表情 收 名字」。'
          : `表情库（${String(names.length)} 张）：\n${names.join('、')}\n\n发「表情 发 名字」可以直接发一张。`)
        return
      }

      case 'retry': {
        const outcome = await this.options.retryDelivery(peerId)
        reply(outcome === 'idle' ? '没有需要重发的回复。' : outcome === 'retried' ? '已重新发送上一条未确认的回复。' : '重试仍未确认发出，可以稍后再发「重试」。')
        return
      }

      case 'stop': {
        // 打断跑偏的一轮：微信里没有别的办法让它停下来。
        const cancelled = await this.options.cancelTurn(peerId, generation)
        reply(cancelled ? '已停止当前任务和待发送内容。' : '现在没有待处理的任务。', this.options.scopeFor?.(peerId))
        return
      }

      default:
        reply(formatUnknown(command.name))
    }
  }
}
