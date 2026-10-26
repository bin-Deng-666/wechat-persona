# 设计

> 目标：微信里一个「像人」的联系人。能在 Mac 上跑，走官方通道，出问题时不丢消息。

## 1. 分层

```text
微信 ⇄ 腾讯 iLink（官方 Bot 通道）
        │  QR 登录 → bot_token → 长轮询 getupdates
        ▼
┌─────────────────────────────────────────────────┐
│ wechat-persona（跑在 DSH 进程内）                │
│                                                 │
│  ilink/     协议层：登录、长轮询、发消息、媒体    │
│            不关心「谁在回」，只保证收发正确       │
│                                                 │
│  persona/   人格层：人格卡、prompt 组装、记忆     │
│            纯函数为主，可单测、可换实现           │
│                                                 │
│  bridge/    桥接层：peer ⇄ DSH 会话，回复投递     │
│            唯一同时能看到两边数据结构的地方       │
└─────────────────────────────────────────────────┘
        │ agent.followup() 入站
        │ session/event → assistant/message 出站
        ▼
     DSH 会话（模型、工具、审批、持久化）
```

**分层的判据**：换掉其中一层，另外两层不需要改。
- 换协议（比如以后官方支持群聊）：只动 `ilink/`
- 换人格机制（比如接 Dify）：只动 `persona/`
- 换宿主（比如以后做成独立应用）：只重写 `bridge/`

## 2. 数据流

### 入站

1. `getupdates` 长轮询（或事件推送）拿到 `WeixinMessage`
2. 过滤：只接受白名单 peer（默认 = 扫码登录的那个微信号）
3. 去重：按 `message_id` 落 `cursor-store`（重启不重放）
4. 媒体：图片/语音/文件走 CDN 下载 + AES 解密，落临时目录
5. `persona/` 取该 peer 的人格卡与设置 → 组装 prompt
6. `bridge/` 找到或创建该 peer 的 DSH 会话 → `agent.followup()`

### 出站

1. 监听 `session/event` 的 durable `assistant/message`
2. 只取一轮结束时的最终回答（旁白、工具参数不投递）
3. 超长按段落切分，逐条发送（整条会被服务端拒绝）
4. `ret: -2` 限流 → 2s/4s/8s/16s 退避，不静默丢弃
5. 发送期间用 `sendtyping` 维持「对方正在输入」

### 会话与代次

- 会话 id 是 peer 的纯函数（`channel-persona-<peerId>`），同样的 peer 永远落到同一个会话
- `/new` 不删旧记录，只递增代次（`~g1`、`~g2`），旧会话仍可回看
- 每个 peer 的工作目录写进会话 header，创建后不可改；切换 cwd 等价于在新目录开新会话

## 3. 人格层

人格不是「一句 system prompt」，是四件可独立演进的东西：

| 组成 | 存放 | 谁改 |
|---|---|---|
| 卡片 | `data/personas/<id>/persona.json` | 用户在 GUI 编辑，或直接塞文件 |
| 素材 | 同目录 `stickers/`、`avatar.png` | 用户 |
| per-chat 设置 | `data/chats/<peerId>/settings.json` | GUI「设置此聊天」 |
| 记忆 | `data/chats/<peerId>/memory.json` | 模型按需写、用户可查看/删除 |

Prompt 组装是纯函数 `buildSystemPrompt(card, context)`，输入输出都是普通对象，不碰 IO。
这样同一份人格可以在单测里断言，也能在 GUI 里预览。

详见 [persona.md](persona.md)。

## 4. 不变量（改坏会静默丢消息）

1. **一轮只发最终回答**：`assistant/message` 是唯一投递源，旁白不发
2. **发送成功以服务端回执为准**：HTTP 200 不等于投递成功，要看返回体
3. **`context_token` 必须回传当前这条消息的值**，不复用旧 token
4. **重启不重放**：游标持久化，进程重启后从游标之后开始
5. **限流退避**：`ret: -2` 至少退避到 16s，重试 3 次后记日志而不是丢弃
6. **只有白名单 peer 能驱动**：陌生消息不建会话、不执行命令、不回复

## 5. 已知边界

- **群聊不支持**：iLink 协议目前没有可靠的群消息语义，硬做等于猜
- **会话会过期**：`errcode -14` → bot token 失效，需重新扫码；插件做暂停 + 提示，不盲目重试
- **图片理解有损**：动图只取有限帧
- **不要用于核心业务**：服务条款允许腾讯随时变更或终止

## 6. 参考实现的关系

协议层的实现细节（长轮询超时、CDN 加解密、字段必填性）参考了 MIT 许可的
[dsh-channel-wechat](https://github.com/wangx-wx/dsh-channel-wechat) 与腾讯官方的
[openclaw-weixin](https://github.com/Tencent/openclaw-weixin)。
产品层（人格、记忆、表情、主动搭话）为本项目原创设计，取自 WeChatAgent 的产品思路而非代码。
