# wechat-persona

微信里的「AI 联系人」——一个 DSH 插件：扫码登录后，你的微信通讯录里多一个能单聊的角色，
有人格、有记忆、会看图、会发表情包，说话像人而不像客服。

- **协议层**：腾讯 2026 年官方开放的 iLink Bot 通道（`ilinkai.weixin.qq.com`），
  按公开协议文档实现，不是 Hook、不是协议破解。
- **产品层**：人格卡（prompt / 温度 / 示例对话）、每个聊天独立上下文与设置、
  图片与表情理解及发送、主动搭话。
- **运行形态**：DSH 插件，跑在 Harness 进程内，复用 DSH 的会话、模型与权限，
  GUI 里有配置页。

> 名字是占位，随时可改（`package.json` 的 `name` + profile patch 的 `id`）。

## 状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 骨架：目录、构建、配置、文档 | ✅ 完成（profile 实测待做） |
| M1 | iLink 协议层 + 扫码登录 + 长轮询收发文本 | ✅ 代码完成，待真实扫码验证 |
| M2 | 人格聊天：人格卡、per-chat 设置、上下文、图片理解 | 人格注入已完成；图片与 per-chat 设置待做 |
| M3 | 表情包、主动搭话、记忆摘要 | 未开始 |

进度与验收标准见 [docs/roadmap.md](docs/roadmap.md)。

## 目录

```text
wechat-persona/
├── docs/                 设计、协议、ADR、路线图
├── src/
│   ├── index.ts          插件入口（cordis apply）
│   ├── config.ts         配置 schema（schemastery）
│   ├── ilink/            iLink 协议：登录、长轮询、发消息、媒体、加密
│   ├── bridge/           DSH 会话桥接：入站注入、出站回发
│   ├── persona/          人格引擎：卡片、prompt 组装、per-chat 设置、记忆
│   └── client/           浏览器端配置页
├── test/                 纯逻辑单测（node --test）
└── scripts/              本地开发脚本
```

## 安装（DSH 桌面版）

`desktop` profile 由桌面应用独占管理，命令行 `dsh plugin --profile desktop add` 会被拒绝，
所以走 GUI：

1. `npm run build && npm pack`，得到 `dsh-wechat-persona-0.1.0-dev.0.tgz`
2. GUI → **Plugins** → 安装本地包 → 选这个 tgz
3. **完全退出并重开** DSH（bundle 层只在启动时组装）
4. 打开 `http://127.0.0.1:<port>/api/persona-wechat/panel`，用手机微信扫码
5. 扫码那个微信号就是你的 bot，在微信里直接发消息

> 同一时间只能有一个 iLink 客户端登录同一个 bot；如果同时装了 `dsh-channel-wechat`，两个会互相踢。

## 本地开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

装进 profile 调试：

```bash
dsh plugin --profile desktop add /Users/dengbin/Desktop/wechat-persona
# 完全退出并重开 DSH 后，在 GUI 的 Plugins 页扫码登录
```

## 与几个先行项目的关系

| 项目 | 我们借什么 | 不借什么 |
|---|---|---|
| [dsh-channel-wechat](https://github.com/wangx-wx/dsh-channel-wechat)（MIT） | iLink 协议层的实现经验与边界（丢消息、限流、长文切分） | 直接依赖它的包；产品层完全自己写 |
| [WeChatAgent](https://github.com/sourcepro5/WeChatAgent) | 产品设计：聊天/助手分权、按聊天授权、人格卡、表情包目录 | Windows Hook、数据库解密、OneBot 中转 |
| 腾讯 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) | 官方协议规范与字段语义 | —— |

协议层若直接改编自 dsh-channel-wechat 的代码，会在 [NOTICE.md](NOTICE.md) 与文件头保留 MIT 署名。

## 许可

MIT，见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。
