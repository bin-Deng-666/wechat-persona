# bridge/

桥接层负责把微信消息交给 DSH，并把最终结果交回微信。

| 文件 | 职责 |
|---|---|
| `session.ts` | peer 与对话代次映射；创建、恢复、借用和释放 agent |
| `prompt.ts` | 当前 agent 作用域的 system-prompt/assemble 接入；人格、记忆、表情目录热更新 |
| `media.ts` | 下载后的媒体 → 宿主附件；归档图片原件；失败说明 |
| `gif.ts` | GIF 多帧合成和有限 PNG 预览；不改写原件 |
| `reply.ts` | durable 最终文本抽取；文字/表情串行发送、限流、重试、节奏 |
| `bubbles.ts` | 按需 `[分条]` 边界与长度限制 |
| `text.ts` | 文本切分、代码块闭合、全角数字和地图链接 |
| `access.ts` | 明确白名单或默认扫码账号 |
| `generations.ts` | “新对话”代次原子落盘 |
| `memory.ts` | 记忆标记、持久化、读取与清空 |
| `activity.ts` | 已知聊天和最后活跃时间 |
| `approval.ts` | 把 ask 审批交给微信，等待 1/2/3 |

用户消息只包含原文与附件，系统提示词由宿主组装并持久化。不要恢复首轮人设拼接、每轮角色提醒，或通过修改 llm 请求临时塞入 system 内容。

表情原件、识别结果与联系人访问范围由 `persona/stickers.ts` 管理。正文中的识别标记先落盘，再进入回复队列；已确认的表情可在同一轮按序使用。

详细数据流、停止流程与限制见 [../design.md](../design.md)。
