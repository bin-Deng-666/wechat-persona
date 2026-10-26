/**
 * 主动搭话的判定。
 *
 * 纯函数：只看「现在几点、对方多久没说话、卡片允不允许」，
 * 定时器与投递在通道运行时里。
 *
 * 三条规则，每条都是为了不烦人：
 * - 免打扰时段内不说（跨零点也算）
 * - 没安静够 minIdleHours 不说
 * - 一轮主动说完就重新计时，避免连续轰炸
 *
 * @module wechat-persona/channel/proactive
 */

/** `HH:mm` 解析成当天的分钟数。 */
export function minutesOfDay(hhmm: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(hhmm.trim())
  if (match === null) return undefined
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * 现在是否处于免打扰时段。
 *
 * 起止相同表示「全天」。跨零点（22:00–08:00）按区间绕回处理。
 * @param nowMinutes - 当天分钟数。
 * @param quiet - `[开始, 结束]`。
 */
export function isQuietNow(nowMinutes: number, quiet: readonly [string, string]): boolean {
  const start = minutesOfDay(quiet[0])
  const end = minutesOfDay(quiet[1])
  if (start === undefined || end === undefined) return false
  if (start === end) return true
  return start < end
    ? nowMinutes >= start && nowMinutes < end
    : nowMinutes >= start || nowMinutes < end
}

export interface ProactiveInput {
  /** 现在（毫秒）。 */
  now: number
  /** 对方最后一次说话（毫秒）；从未说过为 undefined。 */
  lastSeenAt: number | undefined
  /** 卡片允许的最小空闲小时数。 */
  minIdleHours: number
  /** 免打扰时段。 */
  quietHours: readonly [string, string]
  /** 这个聊天是否允许主动。 */
  enabled: boolean
  /** 本地时区偏移（分钟），用于把 now 换成本地时间。 */
  timezoneOffsetMinutes?: number
}

/**
 * 现在该不该主动开口。
 * @param input - 判定所需的全部事实。
 * @returns 该说就 true；任何一条不满足都 false（默认不说）。
 */
export function shouldPoke(input: ProactiveInput): boolean {
  if (!input.enabled) return false
  if (input.lastSeenAt === undefined) return false

  const offset = input.timezoneOffsetMinutes ?? -new Date(input.now).getTimezoneOffset()
  const local = new Date(input.now + offset * 60_000)
  const nowMinutes = local.getUTCHours() * 60 + local.getUTCMinutes()
  if (isQuietNow(nowMinutes, input.quietHours)) return false

  const idleMs = input.now - input.lastSeenAt
  return idleMs >= input.minIdleHours * 60 * 60 * 1_000
}

/** 主动开口时投给模型的那句话。 */
export function proactiveInstruction(): string {
  return '（现在没有新消息。按你的性格主动说一句，一句话就够；不要提到这条提示，也不要解释你在做什么。）'
}
