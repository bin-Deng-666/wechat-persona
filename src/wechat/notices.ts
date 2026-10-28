/**
 * 干活时报平安的短句。
 *
 * 两个来源，优先级明确：
 * 1. 人格卡自己的 `progress` 数组——换人格就换语气，这是默认路径；
 * 2. 内置兜底库——卡片没写或全是非法值时用，保证任何人格都不会「干着活一声不吭」。
 *
 * 这里的句子只说明「还在弄」，不承诺时间、不编造进度。挑选规则只有一条：
 * 一轮之内不重复；一轮用完就重新洗牌，所以下一轮的语气不会雷同。
 *
 * @module wechat-persona/wechat/notices
 */

/** 一行不超过这个长度；再长就不像随口一句，而像一段说明。 */
export const MAX_NOTICE_CHARS = 20

/** 内置兜底：中性、通用，不带任何具体人格的口吻。 */
export const DEFAULT_NOTICES: readonly string[] = [
  '在弄，稍等',
  '这步有点慢',
  '卡了一下，重试中',
  '快好了',
  '我盯着呢',
  '还在跑',
  '换条路试试',
  '差最后一点',
  '有点绕，我在理',
  '还没完',
  '正在收尾',
  '这活儿费劲',
  '有结果就发你',
  '再等一下',
  '我在处理',
  '没停，继续',
  '这步得仔细',
  '这儿有个坎',
  '我再试一次',
  '这次应该行',
  '翻到关键处了',
  '马上',
]

/**
 * 从一个池子里按轮次取句子，取完这一轮才重新洗牌。
 *
 * 用「先洗牌再依次取」而不是「每次随机」：随机会重复，而重复正是上一版被否掉的原因。
 *
 * @param lines - 句子池；空数组时返回 undefined。
 * @param random - 注入随机源，测试里可以固定。
 * @returns 取下一句的函数；池子为空时始终返回 undefined。
 */
export function createNoticePicker(
  lines: readonly string[],
  random: () => number = Math.random,
): () => string | undefined {
  const pool = [...new Set(lines.map(line => line.trim()).filter(line => line !== ''))]
  if (pool.length === 0) return () => undefined
  let queue: string[] = []
  return () => {
    if (queue.length === 0) {
      queue = [...pool]
      // Fisher–Yates：保证一轮内不重复，同时每轮顺序不同。
      for (let index = queue.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1))
        ;[queue[index], queue[other]] = [queue[other]!, queue[index]!]
      }
    }
    return queue.shift()
  }
}

/**
 * 这个人格该用哪套句子。
 *
 * @param card - 已解析的人格卡；`progress` 为空表示回退兜底库。
 */
export function noticesFor(card: { progress?: readonly string[] } | undefined): readonly string[] {
  const own = card?.progress
  return own !== undefined && own.length > 0 ? own : DEFAULT_NOTICES
}
