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
| M2 | 人格聊天：人格卡、per-chat 设置、上下文、图片理解 | ✅ 完成（真机待验证） |
| M3 | 表情发送、主动搭话 | ✅ 完成；记忆摘要未开始 |

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

## 数据长什么样

```text
<dataDir>/                    默认 ~/.dsh/wechat-persona
├── account.json              登录凭据（0600，删掉即退出登录）
├── logs/plugin-YYYY-MM-DD.log 插件自己的诊断日志（启动、轮询、发送失败都在这）
├── cursor.json               每个账号的轮询游标（重启不重放）
├── personas/<id>/persona.json  人格卡，见 docs/persona.md
├── chats/<peer>/settings.json  每聊天：人格、是否回复、长度、是否主动
└── stickers/<名字>.png|gif     表情库；模型写 [表情:名字] 就发这张
```

表情标记的约定：回复里写 `[表情:开心]`，通道会发 `stickers/开心.png`，
再把标记之外的文字发出去；名字找不到或发送失败就退回纯文字。

## 安装（DSH 桌面版）

`desktop` profile 由桌面应用独占管理，命令行 `dsh plugin --profile desktop add` 会被拒绝，
要用应用自带的 CLI：

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
npm run build && npm pack
"$DSH" plugin --profile desktop remove dsh-wechat-persona   # 升级时先移除
"$DSH" plugin --profile desktop add ./dsh-wechat-persona-<version>.tgz
```

装完**完全退出并重开** DSH（bundle 层只在启动时组装）。

## 登录

桌面版的 GUI 跑在 Electron 里，普通浏览器拿不到它的 cookie，所以**面板那条路在桌面版走不通**
（`/api/*` 一律 401，插件路由也只能挂在 `/api` 下）。登录改走终端：

```bash
npm run login                      # 可加 --png /tmp/qr.png 把二维码写成图片
```

扫码 → 手机确认 → 凭据写入 `~/.dsh/wechat-persona/account.json`（0600）。
**正在运行的 DSH 会在几秒内自动接上**（插件监听这个文件），不用重启。

> `/persona-wechat/panel?key=…` 这套带密钥的公开入口是为 `dsh web`（真浏览器）准备的；
> 桌面版宿主的 HTTP 层只把 `/api/*` 转给插件，所以它返回 404。**别指望它。**

## 配置（桌面版目前靠文件）

```text
~/.dsh/wechat-persona/
├── account.json                登录凭据（0600；删掉 = 退出登录）
├── cursor.json                 每个账号的轮询游标（重启不重放）
├── logs/plugin-YYYY-MM-DD.log  插件诊断日志，出问题先看这里
├── personas/<id>/persona.json  人格卡（docs/persona.md）
├── chats/<peer>/settings.json  每聊天：人格 / 是否回复 / 长度上限 / 是否主动
└── stickers/<名字>.png|gif     表情库；回复里写 [表情:名字] 就发这张
```

改完文件**下一条消息即生效**（设置按 mtime 读、人格卡每条消息重扫），不用重启。

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
