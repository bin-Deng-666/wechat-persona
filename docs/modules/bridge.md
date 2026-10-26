# bridge/

DSH 会话桥接层。唯一同时看得见「微信 peer」和「DSH 会话」两种数据结构的地方。

计划文件（M1–M2）：

| 文件 | 职责 |
|---|---|
| `session.ts` | peer ⇄ 会话 id（纯函数）、创建/恢复、代次（`/new`） |
| `inbound.ts` | 入站消息 → `agent.followup()`；媒体 → 附件 |
| `reply.ts` | 订阅 `session/event` 的 durable `assistant/message`，切分、发回 |
| `typing.ts` | 一轮期间的「对方正在输入」心跳 |
| `access.ts` | 白名单：`allow` 列表或扫码登录的那个 id |

不变量：一轮只发最终回答；重启不重放；限流退避不丢消息。见 `docs/design.md` §4。
