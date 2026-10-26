# wechat-persona

运行在 DSH 进程内的微信单聊人格通道，通过腾讯 iLink Bot 接口收发消息，复用宿主的模型、工具、权限与持久化会话。

当前代码支持人格聊天、图片理解、GIF 预览、自动表情收藏、按需多条回复、中文设置、记忆和文件回传。类型检查、单元测试与集成测试覆盖本地流程；微信客户端上的动图展示仍需真机验收。

## 对话如何组成

- **系统提示词**：人格、说话方式、规则、当前时间、记忆、可用表情及适用场景、通道控制标记。
- **用户消息**：微信原文和附件；模型不支持媒体或下载失败时附上简短的读取失败说明。
- **模型回复**：最终文字进入发送队列，控制标记由通道处理，不显示到微信。

人格通过 DSH 的会话作用域 `system-prompt/assemble` 接入，每次模型请求读取当前人格和聊天设置。新建、恢复、借用会话使用同一机制；切人格、改文件、清记忆后，下一次请求生效。宿主的工具规则保持参与组装。

旧版本已写进历史的“角色设定”和“继续扮演”文字不会自动改写。升级后发 **新对话**，可以从干净的用户历史开始，旧记录仍保留。

## 微信里直接使用中文

| 发什么 | 作用 |
|---|---|
| **菜单** / **设置** | 打开设置卡片，回复数字选择人格、模型信息、记忆、分条、新对话、表情库 |
| 帮助 | 列出指令 |
| 新对话 | 新开一段上下文，保留旧记录 |
| 状态 | 看当前人格、对话代次、消息数和权限 |
| 人格 | 列出人格卡 |
| 人格 xiao-jing | 切换人格 |
| 分条 | 看当前发送方式 |
| 分条 160 | 覆盖单条目标字数 |
| 分条 按句 / 按段 / 不切 / 恢复 | 调整分条方式，或恢复人格卡设置 |
| 停止 | 中断当前一轮及待处理输入 |
| 表情 | 列出这个聊天可用的表情 |
| 表情 收 名字 | 明确收藏最近收到的图片 |
| 表情 发 名字 | 直接发送已收藏表情 |

原来的 `/menu`、`/new`、`/persona`、`/style` 等仍可使用。中文指令按整条消息和明确参数格式匹配，“菜单怎么设计”“帮我打开菜单”等聊天内容不会被截成指令。

菜单有效期 5 分钟。正常聊天会收起菜单；数字只在菜单有效期间作为设置选择。通道只响应收到的消息，**没有定时主动搭话及其设置开关**。审批和长任务提示属于你已发起任务的反馈。

## 按需回复一条或多条

短回复默认一条发完。模型在确实需要独立反应或自然停顿时，可以使用 `[分条]` 指定消息边界，通常 2–3 条即可；没有标记就不会为了“像人”强拆每句话。超长回答仍遵守长度和传输上限。

文字与表情进入同一个联系人发送队列，保持顺序，共用节流、失败重试和输入状态。表情失败时保留文字。回复前有短暂停顿，多条之间有间隔；命令和审批提示立即处理。

## 图片、GIF 与自动表情收藏

收到可以下载的 PNG/JPEG/GIF/WebP 后：

1. 保存原始字节，按 SHA-256 去重。
2. 支持视觉的模型接收图片；GIF 解码为最多三张 PNG 预览，原件不转码。
3. 图片先处于待判断状态。模型确认是表情后补充名字、画面/文字描述和适用场景；截图、证件、普通照片与文档不会直接成为可发送表情。
4. 已确认的目录进入后续系统提示词，模型按语境选择 `[表情:素材ID]`，通道发送对应原件。

自动收藏按联系人隔离：同一文件可共用存储，但某人发来的素材和描述不会进入别人的可用表情列表。人工放入 `stickers/shared/` 的图片为共享表情。原有直接放在 `stickers/` 根目录的图片也可使用。

看不到图片时不猜测含义。没有视觉模型或附件服务时可以归档原件，但无法自动确认表情语义；此时仍可用“表情 收 名字”明确收藏。GIF 预览有画布、帧数和总解码量上限，超限或损坏时给出媒体读取说明。

**协议边界**：iLink 提供的原始媒体决定能保存什么。如果服务端只提供静态缩略图，就无法还原原动画。发送 GIF 时保留原始字节，但微信是否按动图播放、是否显示成原生表情形式，必须真机验证，不能以本地上传成功替代。

## 文件与模块

```text
src/
├── index.ts                 宿主接线、登录态、生命周期、文件发送
├── config.ts                插件配置
├── credentials.ts           登录凭据原子写入
├── ilink/                   登录、轮询、消息、媒体 CDN、AES、上传
├── bridge/
│   ├── prompt.ts            会话作用域系统提示词
│   ├── session.ts           peer 与 DSH 会话的创建、恢复、借用
│   ├── media.ts / gif.ts     媒体处理和 GIF 多帧预览
│   ├── reply.ts / bubbles.ts 有序回复队列和可选消息边界
│   └── ...                  准入、代次、记忆、文本与审批
├── persona/                 人格卡、聊天设置、素材和表情目录
└── channel/                 轮询运行时、中文指令、菜单、面板与输入状态
```

运行数据默认位于 `~/.dsh/wechat-persona`：

```text
account.json                   登录凭据（0600；删除即退出）
cursor.json                    按账号保存轮询游标
generations.json               “新对话”的会话代次
last-seen.json                 聊天列表和最后活跃时间
memories.json                  按联系人保存的记忆
logs/plugin-YYYY-MM-DD.log      诊断日志
personas/<id>/persona.json      人格卡，见 docs/persona.md
chats/<peer>/settings.json      人格、启用状态、长度、分条设置
stickers/
├── shared/<名字>.png|gif        人工导入的共享表情
├── assets/<hash前两位>/<完整hash>.gif|png|jpg|webp
│                              按内容去重的原始字节
└── chats/<联系人hash>/index.json
                               来源、格式、时间、状态、名字、描述、场景、最近图片ID
```

原件只用内容哈希命名。名字、说明、适用场景和收藏状态在联系人目录中维护，不靠复制文件重命名来管理。单张自动归档图片上限 20 MiB；模型目录最多提供近期 40 张已确认素材、20 张共享素材和 6 张待判断图片，控制提示词大小。

## 安装与登录

```bash
npm install --legacy-peer-deps
npm run typecheck
npm test
npm run build
npm run pack
```

`pack` 产物在 `release/`。桌面版 profile 由桌面应用管理，使用应用自带 CLI：

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop remove dsh-wechat-persona
"$DSH" plugin --profile desktop add ./release/dsh-wechat-persona-<version>.tgz
```

完全退出并重开 DSH 以重新组装 bundle。登录走终端：

```bash
npm run login
# 同时生成二维码图片：
npm run login -- --png /tmp/wechat-qr.png
```

扫码并在手机确认后，凭据写入 `account.json`。正在运行的插件监听文件，无需为登录再次重启。桌面 Electron 的 cookie 无法由普通浏览器取得，面板不能代替上述登录流程；独立 Web 宿主的配置页仍保留。

## 权限、记忆与限制

- 默认仅扫码登录的微信账号可驱动机器人；`allow` 可显式指定白名单。
- `cordis.patch.yml` 中桌面安装默认权限为 `danger-full-access`。要在微信收审批提示并回 `1/2/3`，改为 `workspace-write`。
- 模型可用 `[记住: 简短事实]` 保存对方明确提供的个人信息。“菜单 → 记忆”可查看或清空；记忆进入系统提示词。自动长历史摘要尚未实现。
- 模型用 `present` 交付的文件可回传到微信，单文件上限 100 MiB。
- iLink 当前不提供可靠群聊、出站原生定位、原生按钮和出站语音支持。
- 真机排障先看 `logs/plugin-*.log`；协议探针为 `scripts/probe-login.ts`。

更多说明见 [docs/README.md](docs/README.md)。协议实现参考腾讯 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 与 MIT 项目 [dsh-channel-wechat](https://github.com/wangx-wx/dsh-channel-wechat)，署名见 [NOTICE.md](NOTICE.md)。MIT 许可见 [LICENSE](LICENSE)。
