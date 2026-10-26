/**
 * wechat-persona — 微信里的「AI 联系人」通道（DSH 插件）。
 *
 * 当前进度：M0 骨架。插件能被加载、校验配置、扫出人格卡并报告；
 * iLink 协议层与通道桥接见 docs/roadmap.md 的 M1。
 *
 * 分层的理由见 docs/design.md：ilink/ 只管收发，persona/ 只管怎么说，
 * bridge/ 是唯一同时看见两边的层。
 *
 * @module wechat-persona
 */

import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

import { Config } from './config.ts'
import type { Config as ConfigShape } from './config.ts'
import { PersonaStore } from './persona/store.ts'

export { Config }
export type { ConfigShape as ConfigOptions }

/** 启动审计与 `pending (waiting for service: …)` 行里报告的名字。 */
export const name = 'persona-wechat'

/**
 * 依赖的宿主服务。
 *
 * M0 不依赖任何服务，所以空数组：配置页与人格扫描都不需要宿主能力。
 * M1 接通道时会加上 `agents`（建会话）、`credentials`（存登录）、`cmdlineArgs`（认 login/logout 动作）。
 */
export const inject = [] as const

/**
 * 插件入口。
 *
 * 只做三件事：校验配置、构造人格仓库、把加载结果报出来。
 * 真正的通道在 M1 挂上来；现在保持「装上去什么都不做也不出错」——
 * 这是插件开发里最容易被跳过、也最容易在用户机器上炸掉的一步。
 *
 * @param ctx - 插件的 cordis 上下文。
 * @param config - 已由 schema 解析的配置。
 */
export function apply(ctx: Context, config: ConfigShape): void {
  const cwd = config.cwd.get()
  if (!isAbsolute(cwd)) {
    throw new Error(`wechat-persona: cwd 必须是绝对路径，收到 ${JSON.stringify(cwd)}`)
  }

  const configured = config.dataDir.get()
  // 相对路径按会话工作目录解析：数据目录最终落在用户能看见的地方，
  // 而不是跟着进程启动目录漂移。
  const dataDir = isAbsolute(configured) ? configured : resolve(cwd, configured)
  const store = new PersonaStore(join(dataDir, 'personas'))
  const logger = ctx.logger(name)

  // 不 await：扫盘失败不该拖住整个 profile 的启动。
  void store.snapshot().then(snapshot => {
    logger.info(
      `人格卡已加载：${String(snapshot.personas.size)} 张` +
        (snapshot.broken.length > 0 ? `，${String(snapshot.broken.length)} 张有问题` : ''),
    )
    for (const broken of snapshot.broken) {
      const detail = broken.issues.map(issue => `${issue.path || '<root>'}: ${issue.message}`).join('; ')
      logger.warn(`人格卡「${broken.id}」未启用：${detail}`)
    }
  }).catch((error: unknown) => {
    logger.warn(`人格卡扫描失败：${String(error)}`)
  })

  logger.debug(`wechat-persona 已挂载，数据目录 ${dataDir}`)
}
