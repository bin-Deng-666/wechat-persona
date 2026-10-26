# wechat-persona

微信里的「AI 联系人」——一个 DSH 插件：扫码登录后，你的微信通讯录里多一个能单聊的角色，
有人格、有记忆、会看图、会发表情包，说话像人而不像客服。

- **协议层**：腾讯 2026 年官方开放的 iLink Bot 通道（`ilinkai.weixin.qq.com`），
  按公开协议文档实现，不是 Hook、不是协议破解。
- **产品层**：人格卡（prompt / 温度 / 示例对话）、每个聊天独立上下文与设置、
  微信内命令（`/new` `/status` `/persona`）、图片与表情、主动搭话。
- **运行形态**：DSH 插件，跑在 Harness 进程内，复用 DSH 的会话、模型、工具与权限。

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
├── src/                        插件源码（构建产物在 lib/，不入库）
│   ├── index.ts                入口：Coordinator（登录态、通道启停、面板、命令接线）
│   ├── config.ts               配置 schema（全部 volatile，GUI 可编辑）
│   ├── credentials.ts          凭据落盘（0600、原子写）
│   ├── ilink/                  iLink 协议：api / 登录状态机 / 媒体下载 / 发图 / 类型
│   ├── bridge/                 会话桥接：peer⇄会话、回复队列、文本切分、媒体降级、
│   │                           人设注入、准入、对话代次
│   ├── persona/                人格卡解析与加载、prompt 组装、每聊天设置、表情库
│   └── channel/                运行时（轮询/命令/主动搭话）、登录会话、面板路由、
│                               输入状态、文件日志、二维码
├── test/                       单测（node --test，237 项，行覆盖 91%）
├── scripts/                    一次性/运维脚本，见 scripts/README.md
├── docs/                       文档索引见 docs/README.md
├── examples/personas/          可直接复制的人格卡样例
├── release/                    打包产物（gitignore）
└── lib/                        构建产物（gitignore）
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
npm run build && npm run pack        # 产物落到 release/
"$DSH" plugin --profile desktop remove dsh-wechat-persona   # 升级时先移除
"$DSH" plugin --profile desktop add ./release/dsh-wechat-persona-<version>.tgz
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

## 微信里的命令

| 命令 | 作用 |
|---|---|
| `/help` | 列出命令 |
| `/new` | 开新一段对话（旧记录保留，不再带上下文） |
| `/status` | 当前人格、第几段对话、累计消息数、权限档位 |
| `/persona` | 列出人格卡（→ 标当前） |
| `/persona <id>` | 切换这个聊天的人格（立即生效） |
| `/style` | 看当前分条方式（几条、每条约多少字、来源） |
| `/style 160` | 每条气泡最多 160 字 |
| `/style sentence` / `paragraph` / `none` | 按句切 / 按段切 / 不切 |
| `/style reset` | 丢掉聊天设置，回到人格卡的值 |
| `/stop` | 打断正在跑的这一轮（排队中的消息一起丢掉） |

命令不会发给模型；回复走和普通回复同一条队列（限流/切分/失败提示都复用）。

## 它在微信里怎么说话

| 行为 | 规则 | 想改怎么办 |
|---|---|---|
| 分条 | 按人格卡的 `reply.maxChars`（默认 120 字）切，最多 4 条，条间隔 1.2 秒 | `/style 160`、`/style sentence`、`/style reset` |
| 连发合并 | 700 毫秒内的几条消息合并成一轮，不会一问三答 | 改 `mergeWindowMs`（代码默认值） |
| 长任务 | 超过 25 秒没输出先回一句「还在弄」 | 改 `progressAfterMs` |
| 失败 | 模型报错、被截断、被中断都会回一句原因，不静默 | — |
| 文件 | 模型用 `present` 交付的文件（docx/pdf/zip）直接发到微信 | 单个文件上限 100 MB |
| 审批 | 会话权限为 `ask` 时，把「要执行什么」发到微信，回 `1` 允许 / `2` 拒绝 / `3` 取消 | 见下面的权限说明 |
| 主动 | 安静够久且不在免打扰时段才开口；活跃时间落盘，重启照样算 | 人格卡 `proactive` + 每聊天开关 |

> 审批只有在权限档位不是 `danger-full-access` 时才会触发：那一档的审批策略是 `never`，
> 服务端直接放行，根本不会问。想用微信审批，把 `cordis.patch.yml` 里的
> `permission` 改成 `workspace-write`。

## 配置（桌面版目前靠文件）

```text
~/.dsh/wechat-persona/
├── account.json                登录凭据（0600；删掉 = 退出登录）
├── cursor.json                 每个账号的轮询游标（重启不重放）
├── generations.json            每个聊天的对话代次（/new 用）
├── last-seen.json              每个聊天最后说话的时间（主动搭话用，重启不丢）
├── logs/plugin-YYYY-MM-DD.log  插件诊断日志，出问题先看这里
├── personas/<id>/persona.json  人格卡（docs/persona.md）
├── chats/<peer>/settings.json  每聊天：人格 / 是否回复 / 长度上限 / 切分粒度 / 是否主动
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
