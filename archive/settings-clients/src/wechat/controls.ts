/** 微信设置入口：默认纯文本菜单；网页面板是同一套设置的可选界面。 */
import { DEFAULT_REPLY_PLAN, resolvePlan, type ReplyPlan } from '../../../../src/reply/bubbles.ts'
import type { ReplyQueue, ReplyScope } from '../../../../src/reply/queue.ts'
import { PersonaStore } from '../../../../src/persona/store.ts'
import { DEFAULT_CHAT_SETTINGS, type ChatSettings, type ChatSettingsStore } from '../../../../src/chat/settings.ts'
import type { PeerGenerations } from '../../../../src/chat/generations.ts'
import type { PeerMemory } from '../../../../src/memory/store.ts'
import type { StickerLibrary } from '../../../../src/stickers/library.ts'
import { normalizeStickerName } from '../../../../src/stickers/markers.ts'
import { MENU_TTL_MS, parseChoice, renderMenu, resolveChoice, type MenuPanel, type MenuView } from './menu.ts'
import { formatAgo, formatCompact, formatHelp, formatNewChat, formatPersona, formatStatus, formatStyle, formatUnknown } from './commands.ts'
import type { CompactOutcome } from '../../../../src/dsh/compaction.ts'
import type { SettingsEntry } from '../panel/server.ts'

export interface ChatControlsOptions {
  personas: PersonaStore
  defaultPersona: string
  settings?: ChatSettingsStore
  generations?: PeerGenerations
  permissionLabel?: string
  memory?: Pick<PeerMemory, 'get' | 'clear' | 'legacy'>
  modelLabel?: string
  stickers?: Pick<StickerLibrary, 'names' | 'adoptLatest'>
  sendSticker?: (peerId: string, name: string, token: string | undefined) => Promise<boolean>
  replies: ReplyQueue
  scopeFor?: (peerId: string) => ReplyScope | undefined
  report?: (line: string, detail?: unknown) => void
  now?: () => number
  planFor: (peerId: string) => ReplyPlan | undefined
  setPlan: (peerId: string, plan: ReplyPlan) => void
  contextTokenFor: (peerId: string) => string | undefined
  /** 长操作交回通道跟踪，让接收循环继续响应「停止」。 */
  runBackground?: (task: Promise<void>) => void
  lastSeen: (peerId: string) => number | undefined
  turnsFor: (peerId: string) => number
  cancelTurn: (peerId: string, generation: number) => Promise<boolean>
  newConversation: (peerId: string) => Promise<number>
  /** 压缩当前对话；缺失表示这个宿主没有压缩能力。 */
  compactConversation?: (peerId: string, generation: number) => Promise<CompactOutcome>
  /** 网页设置入口；缺失或抛错时，「网页设置」会给出可执行的启动方法。 */
  settingsUrl?: (peerId: string) => string | SettingsEntry | undefined | Promise<string | SettingsEntry | undefined>
}

export class ChatControls {
  private readonly options: ChatControlsOptions
  /** 每个联系人的菜单状态；只在有效期内消费数字。 */
  private readonly menus = new Map<string, { panel: MenuPanel; at: number }>()

  constructor(options: ChatControlsOptions) { this.options = options }

  dispose(): void { this.menus.clear() }
  closeMenu(peerId: string): void { this.menus.delete(peerId) }

  /** 打开设置菜单。 */
  async openMenu(peerId: string, panel: MenuPanel = 'root', contextToken?: string): Promise<void> {
    this.menus.set(peerId, { panel, at: (this.options.now ?? Date.now)() })
    await this.answer(peerId, renderMenu(panel, await this.menuView(peerId)), contextToken)
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
    if (resolveChoice(panel, choice).kind === 'action' && panel === 'root' && choice === 6) {
      const task = this.execute(peerId, { name: 'compact', args: [] }, generation, this.options.contextTokenFor(peerId))
        .catch(async error => {
          this.options.report?.('菜单压缩未完成', { peerId, error: String(error) })
          await this.answer(peerId, '压缩未完成，可以稍后再试。', this.options.contextTokenFor(peerId))
        })
      if (this.options.runBackground) this.options.runBackground(task)
      else await task
    } else {
      await this.applyChoice(peerId, panel, choice, this.options.contextTokenFor(peerId))
    }
    return true
  }

  private async applyChoice(peerId: string, panel: MenuPanel, choice: number, contextToken: string | undefined): Promise<void> {
    const resolved = resolveChoice(panel, choice)
    if (resolved.kind === 'close') {
      await this.answer(peerId, '设置已关闭。', contextToken)
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
    const current = await this.settingsFor(peerId)
    const card = PersonaStore.resolve(current.personaId ?? this.options.defaultPersona, await this.ensureSnapshot())

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
        await this.answer(peerId, '记忆已清空。', contextToken)
        return
      }
      case 'split-sentence':
      case 'split-paragraph':
      case 'split-none': {
        if (settings === undefined) break
        const split: ChatSettings['split'] =
          resolved.action === 'split-sentence' ? 'sentence' : resolved.action === 'split-paragraph' ? 'paragraph' : 'none'
        const next = await settings.update(peerId, latest => ({ ...latest, split }))
        this.options.setPlan(peerId, resolvePlan(card, next))
        await this.answer(peerId, split === 'none' ? '已改为整条发送。' : `已改为按${split === 'sentence' ? '句子' : '段落'}发送。`, contextToken)
        return
      }
      case 'max-chars-200': {
        if (settings === undefined) break
        const next = await settings.update(peerId, latest => ({ ...latest, maxChars: 200 }))
        this.options.setPlan(peerId, resolvePlan(card, next))
        await this.answer(peerId, '每条最多 200 字。', contextToken)
        return
      }
      case 'style-reset': {
        if (settings === undefined) break
        const next = await settings.update(peerId, latest => ({ ...latest, maxChars: undefined, split: undefined }))
        this.options.setPlan(peerId, resolvePlan(card, next))
        await this.answer(peerId, '已恢复人格卡的分条方式。', contextToken)
        return
      }
      default: {
        const match = /^persona-(\d+)$/u.exec(resolved.action)
        if (match !== null && settings !== undefined) {
          const index = Number(match[1]) - 1
          const picked = [...(await this.ensureSnapshot()).personas.values()][index]
          if (picked !== undefined) {
            await settings.update(peerId, latest => ({ ...latest, personaId: picked.card.id }))
            await this.answer(peerId, `已切到「${picked.card.name}」，下一轮生效。`, contextToken)
            return
          }
        }
      }
    }
    // 走到这里说明没执行任何动作：把当前面板再发一次，让用户重选。
    await this.openMenu(peerId, panel, contextToken)
  }

  /** 组装菜单展示所需的当前状态。 */
  private async menuView(peerId: string): Promise<MenuView> {
    const snapshot = await this.ensureSnapshot()
    const settings = await this.settingsFor(peerId)
    const card = PersonaStore.resolve(settings.personaId ?? this.options.defaultPersona, snapshot)
    const plan = resolvePlan(card, settings)
    const names = await this.options.stickers?.names(peerId) ?? []
    const memories = this.options.memory?.get(peerId) ?? []
    const legacy = this.options.memory?.legacy(peerId) ?? []
    return {
      personaId: card.id,
      personaName: card.name,
      personaChoices: [...snapshot.personas.values()].map(persona => ({ id: persona.card.id, name: persona.card.name })),
      memoryCount: memories.length + legacy.length,
      memoryFacts: [...memories.map(memory => `[${memory.type}] ${memory.content}`), ...legacy.map(text => `[旧版未核实] ${text}`)],
      maxChars: plan.softChars,
      split: plan.splitMode,
      overridden: settings.maxChars !== undefined || settings.split !== undefined,
      stickerCount: names.length,
      stickerNames: names,
    }
  }

  /** 一条纯文本回复（走正常队列，限流与失败提示都复用）。 */
  private async answer(peerId: string, text: string, contextToken: string | undefined): Promise<void> {
    const plan = this.options.planFor(peerId) ?? DEFAULT_REPLY_PLAN
    const started = (this.options.now ?? Date.now)()
    // 菜单、网址必须整条发出：按人格卡的字数切开会让数字选项对不上。
    void this.options.replies.enqueue(peerId, text, contextToken, { ...plan, splitMode: 'none', softChars: 4096 }, { immediate: true, scope: this.options.scopeFor?.(peerId) })
      .then(outcome => this.options.report?.(`菜单投递：${outcome.status}（${String((this.options.now ?? Date.now)() - started)}ms）`))
  }

  /** 网页设置的入口地址；没有常驻服务时返回 undefined。 */
  private async settingsEntry(peerId: string): Promise<SettingsEntry | string | undefined> {
    try { return await this.options.settingsUrl?.(peerId) } catch { return undefined }
  }

  /** 回复网页设置入口；服务没起来时给可执行的下一步。 */
  private async sendSettings(peerId: string, contextToken: string | undefined): Promise<void> {
    const entry = await this.settingsEntry(peerId)
    if (entry === undefined) {
      await this.answer(peerId, [
        '网页设置还没有启动。',
        '在电脑的插件目录执行一次：',
        '  npm run settings:install',
        '之后重新发送「网页」。',
        '平时管理用微信里的菜单就够了。',
      ].join('\n'), contextToken)
      return
    }
    const link = typeof entry === 'string' ? entry : entry.url
    const code = typeof entry === 'string' ? undefined : entry.code
    const alternates = typeof entry === 'string' ? [] : entry.alternates ?? []
    const scope = typeof entry === 'string' ? 'lan' : entry.scope
    const lines = ['网页设置：', link]
    if (code !== undefined) lines.push(`绑定码：${code}（10 分钟有效，首次打开时输入）`)
    if (scope === 'public') lines.push('打开即用，不需要与电脑在同一网络。')
    else if (scope === 'lan') {
      lines.push('手机与电脑需要连同一网络。')
      if (alternates.length > 0) lines.push(`iPhone 也可以试用：${alternates[0]}`)
    } else lines.push('在运行 bot 的这台电脑上打开。')
    if (code !== undefined) lines.push('可收藏页面或添加到手机桌面，下次直接打开。')
    await this.answer(peerId, lines.join('\n'), contextToken)
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

      case 'web': {
        await this.sendSettings(peerId, contextToken)
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
        const outcome = this.options.compactConversation === undefined
          ? { kind: 'unavailable' as const }
          : await this.options.compactConversation(peerId, generation)
        reply(formatCompact(outcome))
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
            ? '最近没有可收的图：先发一张图给我，再说「表情 收 名字」。'
            : `收好了：${saved}。之后它会用 [表情:${name}] 发这张。`)
          return
        }
        if (sub === '发' || sub === '发送') {
          const name = normalizeStickerName(command.args.slice(1).join(' '))
          if (name === undefined) {
            reply('用法：表情 发 名字')
            return
          }
          const sent = await this.options.sendSticker?.(peerId, name, contextToken)
          reply(sent === true ? `已发出「${name}」。` : `没发出去：表情库里没有「${name}」。发「设置」看有哪些。`)
          return
        }
        const names = await this.options.stickers?.names(peerId) ?? []
        reply(names.length === 0
          ? '表情库是空的。把图片放进 stickers/ 目录（支持 png/jpg/gif/webp），或先发图再说「表情 收 名字」。'
          : `表情库（${String(names.length)} 张）：\n${names.join('、')}\n\n发「表情 发 名字」可以直接发一张。`)
        return
      }

      case 'stop': {
        // 打断跑偏的一轮：微信里没有别的办法让它停下来。
        const cancelled = await this.options.cancelTurn(peerId, generation)
        reply(cancelled ? '已停止当前任务和待发送内容。' : '现在没有待处理的任务。', this.options.scopeFor?.(peerId))
        return
      }

      case 'style': {
        // 分条方式以前只能手改 settings.json，等于没有；这条命令是它的入口。
        const settings = this.options.settings
        if (settings === undefined) {
          reply('这个部署没有可写的聊天设置。')
          return
        }
        const current = await this.settingsFor(peerId)
        const card = PersonaStore.resolve(current.personaId ?? this.options.defaultPersona, await this.ensureSnapshot())
        const plan = resolvePlan(card, current)
        const wanted = command.args[0]?.toLowerCase()

        if (wanted === undefined) {
          await this.openMenu(peerId, 'style', contextToken)
          return
        }

        if (wanted === 'reset') {
          const next = await settings.update(peerId, latest => ({ ...latest, maxChars: undefined, split: undefined }))
          this.options.setPlan(peerId, resolvePlan(card, next))
          reply(`已恢复人格卡的分条方式：每条约 ${String(card.reply.maxChars)} 字，按${card.reply.split === 'sentence' ? '句子' : card.reply.split === 'none' ? '不切' : '段落'}切。`)
          return
        }

        if (wanted === 'sentence' || wanted === 'paragraph' || wanted === 'none') {
          const mode: ChatSettings['split'] = wanted
          const next = await settings.update(peerId, latest => ({ ...latest, split: mode }))
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
        const next = await settings.update(peerId, latest => ({ ...latest, maxChars: clamped }))
        this.options.setPlan(peerId, resolvePlan(card, next))
        reply(`每条最多 ${String(clamped)} 字，下一条生效。`)
        return
      }

      default:
        reply(formatUnknown(command.name))
    }
  }
}
