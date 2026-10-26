/**
 * 插件配置。
 *
 * 全部字段 `volatile`：设置服务只把 volatile 字段投影成 GUI 表单，
 * 非 volatile 字段在表单里是「不存在」而不是「只读」。所以运行时一律通过 `.get()` 读。
 *
 * `cwd` 必填且不给默认值：会话 header 里的 cwd 写入后不可改，
 * 静默默认会把一个操作者从未选择过的目录永久写进会话。
 *
 * @module wechat-persona/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export interface Config {
  /** 这个通道创建的会话所记录的工作目录（绝对路径）。 */
  cwd: Volatile<string>
  /** 人格卡、聊天设置、记忆、媒体缓存的根目录；相对路径按 profile 目录解析。 */
  dataDir: Volatile<string>
  /** 允许驱动机器人的微信 id，一行一个；留空 = 只允许扫码登录的那个号。 */
  allow: Volatile<string>
  /** 新聊天默认使用的人格 id。 */
  defaultPersona: Volatile<string>
  /** 诊断日志保留天数。 */
  logRetentionDays: Volatile<number>
  /**
   * 这个通道创建的会话的权限预设。
   *
   * - `workspace-write`：工作区内可写，敏感操作要审批（默认）
   * - `danger-full-access`：不再询问，什么都能干。**微信里没人能点审批，所以只有这个档位能真正干活**
   */
  permission: Volatile<'read-only' | 'workspace-write' | 'danger-full-access'>
}

// 不标注为 `Config`：schema 的构建器签名与 `Volatile<>` 在 exactOptionalPropertyTypes 下会打架，
// 让 cordis 自己推断解析后的形状，`apply` 那边用接口收窄即可。
export const Config = z.object({
  // 绝对路径：会话边界拒绝相对 cwd，在配置层就失败并点名字段，
  // 比在会话创建时失败（离原因很远）好得多。
  cwd: z.string().required().volatile(),
  dataDir: z.string().default('data/wechat-persona').volatile(),
  // 纯字符串而非列表：GUI 表单模型只写单段路径，嵌套控件能渲染但存不下去。
  // 换行分隔，一行一个 id。
  allow: z.string().default('').volatile(),
  defaultPersona: z.string().default('default').volatile(),
  logRetentionDays: z.number().min(0).default(7).volatile(),
  // 默认保守：审批卡还没接上时，用户至少能看见「卡住了」而不是被静默执行。
  permission: z
    .union([z.const('read-only'), z.const('workspace-write'), z.const('danger-full-access')])
    .default('workspace-write')
    .volatile(),
})
