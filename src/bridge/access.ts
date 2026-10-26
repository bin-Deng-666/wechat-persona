/**
 * 谁可以驱动机器人。
 *
 * 默认只放行扫码登录的那个微信号。`allow` 非空时**以名单为准**，登录者不再自动包含——
 * 页面上显示的名单就是被放行的人，不含隐藏项。
 *
 * 这不是「防陌生人」的礼貌性检查：同一条入站路径能到达 `/model`、`/cwd` 这类命令，
 * 放错一个人等于把 shell 交出去。
 *
 * @module wechat-persona/bridge/access
 */

export interface AccessPolicy {
  /** 这个 peer 是否放行。 */
  admits(peerId: string): boolean
  /** 名单为空且没有记录到 owner 时为 false，用于启动时报警。 */
  admitsAnyone(): boolean
  /** 实际生效的名单，供 GUI 展示与日志。 */
  effective(): readonly string[]
}

/**
 * 解析 `allow` 配置：换行或逗号分隔，去空白、去空行、去重。
 * @param raw - 配置里的原始字符串。
 */
export function parseAllowList(raw: string | undefined): string[] {
  if (raw === undefined) return []
  const seen = new Set<string>()
  for (const token of raw.split(/[\s,，;；]+/u)) {
    const trimmed = token.trim()
    if (trimmed !== '') seen.add(trimmed)
  }
  return [...seen]
}

/**
 * 构造访问策略。
 *
 * @param options.allow - 配置里的名单（原始字符串或已解析数组）。
 * @param options.owner - 扫码登录的那个用户 id；未知时为 undefined。
 */
export function createAccessPolicy(options: { allow?: string | readonly string[]; owner?: string | undefined }): AccessPolicy {
  const listed = typeof options.allow === 'string' || options.allow === undefined
    ? parseAllowList(options.allow)
    : [...options.allow]
  const owner = options.owner?.trim() === '' ? undefined : options.owner?.trim()
  const effective = listed.length > 0 ? listed : owner === undefined ? [] : [owner]
  const set = new Set(effective)

  return {
    admits: peerId => set.has(peerId.trim()),
    admitsAnyone: () => set.size > 0,
    effective: () => effective,
  }
}
