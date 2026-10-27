/** Cordis 插件安装：配置、宿主服务接入和微信审批。 */
import { isAbsolute, join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Config as ConfigShape } from './config.ts'
import { Coordinator, type ApprovalOutcome } from './coordinator.ts'
import { name } from './identity.ts'
import { seedDefaultPersona } from '../persona/store.ts'
import type { AgentRegistryLike } from '../dsh/sessions.ts'

/** `approval/request` waterfall 的请求形状（只取用得到的字段）。 */
interface ApprovalRequestLike {
  agent: { id: unknown }
  toolName: string
  reason?: string
  displayReason?: Record<string, string>
}

/**
 * 插件入口。
 * @param ctx - cordis 上下文。
 * @param config - 已解析的配置。
 */
export function apply(ctx: Context, config: ConfigShape): void {
  try {
    boot(ctx, config)
  } catch (error) {
    // 插件出错不能拖垮整个 profile：装错了要能开机、能看见日志、能卸载。
    ctx.logger(name).error(`wechat-persona 启动失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 真正的启动逻辑；异常由 {@link apply} 兜住。 */
function boot(ctx: Context, config: ConfigShape): void {
  const cwd = config.cwd.get()
  if (!isAbsolute(cwd)) {
    throw new Error(`wechat-persona: cwd 必须是绝对路径，收到 ${JSON.stringify(cwd)}`)
  }
  const configured = config.dataDir.get()
  const dataDir = isAbsolute(configured) ? configured : resolve(cwd, configured)
  // 启动时留一行，方便在宿主日志里确认「插件真的被加载了、用的是哪个目录」。
  // 首次启动把内置默认人格落盘：否则 defaultPersona 指向一张不存在的卡，
  // 用户会看到「列表空着、但回复有人设」这种自相矛盾的状态。
  void seedDefaultPersona(join(dataDir, 'personas'))
  // 表情目录先建好：没有目录时用户不知道该把图放哪，`/表情` 也只能说「空的」。
  void mkdir(join(dataDir, 'stickers'), { recursive: true }).catch(() => {})
  void mkdir(join(dataDir, 'stickers', 'shared'), { recursive: true }).catch(() => {})
  const coordinator = new Coordinator(ctx, config, dataDir)
  coordinator.announceBoot(`cwd=${cwd} dataDir=${dataDir}`)

  void ctx.inject(['agents', 'systemPrompt'], injected => {
    const registry = injected.get('agents') as AgentRegistryLike | undefined
    if (registry === undefined) return
    void coordinator.attach(registry).catch((error: unknown) => {
      injected.logger(name).warn(`恢复登录失败：${String(error)}`)
    })
    injected.effect(() => () => { void coordinator.dispose() })
  })

  // 审批半边：本通道的会话要问就发到微信，其余（GUI 开的会话）交给别人。
  void ctx.inject(['agents'], injected => {
    const events = injected as unknown as {
      on?: (
        name: 'approval/request',
        listener: (request: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>,
        options?: { prepend?: boolean },
      ) => () => void
    }
    // 精简宿主（测试、headless 组合）可能没有事件总线：没有就不转发审批。
    if (events.on === undefined) return
    injected.effect(() => events.on!(
      'approval/request',
      async (request, next) => await coordinator.answerApproval(request, next),
      // 抢在 GUI 的审批卡前面：投到微信的是「本通道的会话」，不该同时弹桌面卡片。
      { prepend: true },
    ))
  })
}
