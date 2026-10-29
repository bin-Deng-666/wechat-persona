/**
 * 轮询游标的落盘判据。
 *
 * 长轮询每几秒就会返回一次，`get_updates_buf` 也可能原样返回上一次的值。
 * 只要拿「启动时的基线」去比较，就会每次轮询都判定为「变了」，
 * 于是游标文件被无意义地重写一遍——盘在转，内容没变。
 *
 * 判据只有一条：**只在真正前进时写**。基线跟着落盘一起前进。
 *
 * @module wechat-persona/wechat/cursor
 */

/**
 * 这次轮询拿到的游标是否值得落盘。
 *
 * @param persisted - 上一次已经落盘的值；从未落盘时为 undefined。
 * @param current - 本轮轮询后的当前值；通道还没拿到游标时为 undefined。
 * @returns true 表示值确实变了、应当写入。
 */
export function shouldPersistCursor(
  persisted: string | undefined,
  current: string | undefined,
): current is string {
  if (current === undefined) return false
  return current !== persisted
}
