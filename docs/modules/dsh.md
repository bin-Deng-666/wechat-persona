# DSH 适配

`src/dsh/` 是宿主 API 的适配边界。微信通道只使用这些接口来操作会话，不依赖宿主内部的 loop 实现。

| 文件 | 职责 |
|---|---|
| `sessions.ts` | peer + generation 映射；创建、恢复、借用、停止和释放 agent |
| `system-prompt.ts` | 当前 agent 作用域 system-prompt/assemble；读取人格、记忆和表情目录 |
| `attachments.ts` | iLink 下载后的媒体转换为宿主附件，能力不足时降级说明 |
| `events.ts` | 从 durable assistant/message 中提取最终回答，排除工具旁白和中断片段 |
| `approvals.ts` | 工具审批转微信问题，解析 1/2/3 并处理超时或取消 |

`media/gif.ts` 和 `media/image.ts` 负责通用媒体处理；`reply/queue.ts` 负责发送顺序和重试；`chat/` 管理独立持久状态。它们不再混放在同一个 bridge 目录。

用户消息只包含原文与附件，系统提示词由宿主组装并持久化。不要通过改写用户消息或临时修改 llm 请求来注入人设。

表情原件与联系人目录由 `stickers/library.ts` 管理。标记解析在纯函数模块 `stickers/markers.ts`，不要求回复队列加载文件存储能力。

目录与依赖规则见 [../structure.md](../structure.md)，完整数据流见 [../design.md](../design.md)。
