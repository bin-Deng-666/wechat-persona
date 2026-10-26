/**
 * 长任务的进度提示文案。
 *
 * 以前这里是插件写死的一句「还在处理，稍等一下。」，和当下在做什么无关。
 * 现在优先用模型这一步自己的旁白——它刚说过要做什么，比插件的固定台词贴实际；
 * 模型没说话时才按正在跑的工具生成一句短句。
 *
 * @module wechat-persona/wechat/progress
 */

/** 工具名 → 一句人话；只在模型没有旁白时使用。 */
const TOOL_LINES: Record<string, string> = {
  bash: '还在跑命令，稍等一下。',
  read: '还在看文件，稍等一下。',
  glob: '还在找文件，稍等一下。',
  grep: '还在搜代码，稍等一下。',
  write: '还在写文件，稍等一下。',
  edit: '还在改代码，稍等一下。',
  web_search: '还在查资料，稍等一下。',
  web_fetch: '还在读网页，稍等一下。',
}

/**
 * 给这次等待配一句提示。
 *
 * 优先级：模型自己的旁白 → 按当前工具生成的一句。两者都没有时返回 undefined：
 * 宁可不发，也不要重复一句和当下无关的固定台词。
 *
 * @param status - 当前活动记下的旁白与工具名。
 */
export function progressLine(status: { narration?: string; toolName?: string } | undefined): string | undefined {
  const narration = status?.narration?.replace(/\s+/gu, ' ').trim()
  if (narration !== undefined && narration !== '') {
    return narration.length > 80 ? `${narration.slice(0, 80)}…` : narration
  }
  const tool = status?.toolName
  if (tool === undefined) return undefined
  return TOOL_LINES[tool] ?? `还在用 ${tool}，稍等一下。`
}
