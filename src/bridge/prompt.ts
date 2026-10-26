/**
 * 微信会话的系统提示词接入。
 *
 * 每次 DSH 组装模型请求时读取当前人格、聊天设置、记忆和表情库，
 * 作为会话作用域的 system section 参与宿主组装。用户消息不经过这里。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

import { buildSystemPrompt } from '../persona/prompt.ts'
import { PersonaStore } from '../persona/store.ts'
import type { ChatSettingsStore } from '../persona/settings.ts'
import type { PeerMemory } from './memory.ts'
import type { StickerLibrary } from '../persona/stickers.ts'

export const PERSONA_SECTION = 'wechat-persona:persona'

export interface PeerSystemPromptOptions {
  personas: PersonaStore
  settings: ChatSettingsStore
  defaultPersona: () => string
  memory: PeerMemory
  stickers: StickerLibrary
  now?: () => Date
  timeZone?: string
  /** 诊断出口。 */
  report?: (line: string, detail?: unknown) => void
}

/** 一个通道运行拥有的会话提示词注册；不修改全局提示词或其他会话。 */
export class PeerSystemPrompt {
  private readonly options: PeerSystemPromptOptions
  private readonly bindings = new Map<object, () => void>()

  constructor(options: PeerSystemPromptOptions) {
    this.options = options
  }

  /** 新建、恢复和借用会话共用同一个入口；同一个 agent 只注册一次。 */
  install(ctx: Context, agent: object, peerId: string): void {
    if (this.bindings.has(agent)) return
    if (ctx.get('systemPrompt') === undefined) {
      // 没有提示词服务就不装人设：抛错会打断会话创建，用户只看到「这条没接上」，
      // 比「它没按人设说话」更难排查。
      this.options.report?.('宿主没有 systemPrompt 服务，这段会话不会加载人格设定')
      return
    }
    const dispose = ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembly = await next()
      // 子 agent 的作用域会继承父监听器，但联系人设定只属于这一段微信会话。
      if (context.agent !== agent) return assembly
      const text = await this.render(peerId)
      return this.withPersona(assembly, text)
    })
    this.bindings.set(agent, dispose)
  }

  /** 每次请求重新解析当前状态；切人格、清记忆、改文件均在下次请求生效。 */
  async render(peerId: string): Promise<string> {
    const [snapshot, settings, stickerPrompt] = await Promise.all([
      this.options.personas.snapshot(),
      this.options.settings.get(peerId),
      this.options.stickers.prompt(peerId),
    ])
    const original = PersonaStore.resolve(settings.personaId ?? this.options.defaultPersona(), snapshot)
    const card = settings.maxChars === undefined
      ? original
      : { ...original, reply: { ...original.reply, maxChars: settings.maxChars } }
    const persona = buildSystemPrompt(card, {
      peer: peerId,
      now: (this.options.now ?? (() => new Date()))(),
      timeZone: this.options.timeZone,
      memory: this.options.memory.lineFor(peerId),
    })
    return `${persona}\n\n# 微信通道\n` + [
      '只响应对方发来的消息，不主动搭话。用户消息保留微信原文和附件；GIF 会提供有限的 PNG 预览帧，不能据此声称看到了完整动画。',
      '通常一条消息即可。几个独立反应或自然停顿确实适合分开发时，用 [分条] 分隔，通常 2–3 条即可。不要把每句话都拆开，不要为了凑条数重复，也不要在正文解释控制标记。',
      '需要跨对话保留、且对方明确提供的个人事实，可在回复末尾写 [记住: 一条简短事实]。不要记录猜测、临时任务或整段聊天。',
      '需要提供位置时写 [位置:纬度,经度,名字]，通道会将它转成地图链接。',
    ].join('\n') + (card.media.sendStickers ? `\n\n${stickerPrompt}` : '')
  }

  private withPersona(assembly: PromptAssembly, text: string): PromptAssembly {
    return {
      ...assembly,
      sections: [...assembly.sections, { name: PERSONA_SECTION, text, interpolate: false }],
    }
  }

  /** 通道重载/退出时只撤销自己的贡献；借用的 agent 继续由原 owner 管理。 */
  dispose(): void {
    for (const dispose of this.bindings.values()) dispose()
    this.bindings.clear()
  }
}
