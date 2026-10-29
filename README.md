# wechat-persona

[![CI](https://github.com/bin-Deng-666/wechat-persona/actions/workflows/ci.yml/badge.svg)](https://github.com/bin-Deng-666/wechat-persona/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24-brightgreen.svg)](package.json)

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
| **设置** / **菜单** | 打开微信内菜单：换人格、换模型、记忆、表情库、新对话、压缩 |
| **帮助** | 获取全部中文触发指令、用途和表情用法 |
| **新对话** | 新开一段上下文，旧记录保留 |
| **压缩** | 把当前对话的旧历史压成摘要，腾出上下文 |
| **人格** / **人格 <id>** | 打开人格选择菜单，或直接切换指定人格 |
| **记忆** | 查看个人记忆摘要；清空前需再次确认 |
| **表情** | 查看表情库和使用方法 |
| **表情 收 名字** | 收藏刚收到的图片 |
| **表情 发 名字** | 发送指定表情 |
| **状态** | 查看当前人格、对话段数和最近活跃时间 |
| **停止** | 中断当前一轮及待处理输入 |

设置直接回复一条简洁的微信消息，无需打开网页。回复编号选择；子菜单发 `0` 或“返回”回到上一级，主菜单发 `0` 或“关闭”退出。菜单五分钟内有效，开始正常聊天会自动收起。原来的 `/menu`、`/settings`、`/help` 等快捷写法仍可用。

分条设置菜单和触发指令已移除。中文指令要求整条消息匹配，普通聊天不会因提到设置而被截走；菜单关闭后，数字仍是正常消息（待审批时除外）。通道没有定时主动搭话。

网页设置、独立 HTTP 服务和原生小程序已归档到 [archive/settings-clients/](archive/settings-clients/README.md)，保留源码、测试、脚本及接入快照供以后复用，不进入当前插件的构建或安装包。

## 按需回复一条或多条

短回复默认一条发完。模型在确实需要独立反应或自然停顿时，可以使用 `[分条]` 指定消息边界，通常 2–3 条即可；没有标记就不会为了“像人”强拆每句话。超长回答仍遵守长度和传输上限。

文字与表情进入同一个联系人发送队列，保持顺序，共用节流、失败重试和输入状态。表情失败时保留文字。多条之间有发送间隔；命令和审批提示立即处理。

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
├── index.ts        公共导出入口
├── app/            插件安装、服务装配、账号和通道生命周期、日志
├── auth/           登录流程、凭据、二维码
├── wechat/         消息通道、设置入口、快捷命令、准入、输入状态
├── ilink/          微信协议、API、登录状态机、CDN、AES、收发
├── dsh/            会话、系统提示词、附件、事件、审批的宿主适配
├── chat/           对话活动、原始消息、交付记录、设置与代次
├── memory/         个人记忆、原话证据、检索、版本与删除记录
├── persona/        人格卡校验、加载和提示词渲染
├── stickers/       表情原件和联系人目录；独立的文本标记解析
├── media/          通用图片格式识别、GIF 预览
├── reply/          文字/表情发送队列、分条与重试
├── text/           长文切分、数字归一化、定位链接
└── storage/        私有文件原子写入、并发锁和串行变更
```

完整目录、依赖边界和代码放置规则见 [docs/structure.md](docs/structure.md)。测试按模块组织在 `test/` 的对应子目录，跨模块场景在 `test/integration/`；`npm test` 递归运行。新安装包在 `release/`，构建产物与运行数据不提交到仓库。

运行数据默认位于 `~/.dsh/wechat-persona`：

```text
account.json                   登录凭据（0600；删除即退出）
cursor.json                    按账号保存轮询游标
generations.json               “新对话”的会话代次
last-seen.json                 聊天列表和最后活跃时间
memory/<联系人hash>.json       有来源和版本的个人记忆、删除记录、旧版未核实资料
conversations/<账号hash>/<联系人hash>.json
                               原始消息、会话批次、逐项交付结果、任务状态
memories.json                  旧版文件保留；无来源内容不自动成为可信个人事实
logs/plugin-YYYY-MM-DD.log      诊断日志
personas/<id>/persona.json      人格卡，见 docs/persona.md
chats/<联系人hash>/settings.json 人格与启用状态
stickers/
├── shared/<名字>.png|gif        人工导入的共享表情
├── assets/<hash前两位>/<完整hash>.gif|png|jpg|webp
│                              按内容去重的原始字节
└── chats/<联系人hash>/index.json
                               来源、格式、时间、状态、名字、描述、场景、最近图片ID
```

原件只用内容哈希命名。名字、说明、适用场景和收藏状态在联系人目录中维护，不靠复制文件重命名来管理。单张自动归档图片上限 20 MiB；模型目录最多提供近期 40 张已确认素材、20 张共享素材和 6 张待判断图片，控制提示词大小。

## 自定义人格

人格就是一个文件：`~/.dsh/wechat-persona/personas/<id>/persona.json`。复制 [examples/personas/jarvis/persona.json](examples/personas/jarvis/persona.json)，把 `id` 改成目录名即可；字段说明见 [docs/persona.md](docs/persona.md)。保存后下一条消息生效，不用重启。

- “人格”打开选择菜单，“人格 <id>”直接切换，“设置 → 换人格”也能选
- 编辑本机人格 JSON 后下一条消息生效
- 卡片有错误不会阻塞启动，会在插件日志中记录校验警告
- 示例里的“贾维斯”是一份管家风格的原创写作，仅作演示，与任何作品无关

卡片里可写的字段只有 `id`、`name`、`description`、`prompt`、`reply`、`examples` 和 `media.sendStickers`。写错或写入已移除的字段不会生效，但会得到一条明确的警告。

## 已归档的客户端

网页、设备长期登录、独立后台和微信小程序的历史实现见 [归档说明](archive/settings-clients/README.md)。归档有独立检查命令和迁移清单，当前插件不注册网页路由或本机控制 socket。此前安装的后台服务和运行数据不会因源码归档而自动删除。

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

扫码并在手机确认后，凭据写入 `account.json`。正在运行的插件监听文件，无需为登录再次重启。登录后直接在微信发送“设置”或“帮助”。

## 权限、记忆与限制

- 默认仅扫码登录的微信账号可驱动机器人；`allow` 可显式指定白名单。
- `cordis.patch.yml` 中桌面安装默认权限为 `danger-full-access`。要在微信收审批提示并回 `1/2/3`，改为 `workspace-write`。
- 模型可用 `wechat_memory_search` / `wechat_memory_write` 检索和保存有原话来源的个人信息；任务状态使用独立的 `wechat_task_update`，上下文压缩后仍可见。“设置 → 个人记忆”可查看摘要并确认清空；精确检索、带版本的增改删通过会话记忆工具完成。普通聊天只自动加载沟通习惯，其他类别按需检索。旧版无来源记忆保留为未核实资料，不自动注入。
- “停止”同时取消模型任务和未发出的气泡；“新对话”使旧代次的迟到输出失效。任务中的补充进入模型的下一步骤，媒体处理保持原始顺序。
- 文本、表情和文件共用发送队列；记录服务端接受、失败、取消和结果不明。失败或结果不明时可直接发送「重试」，只补发已保存的未确认内容，不重新运行模型；服务端接受不代表用户已读。
- 模型用 `present` 交付的文件可回传到微信，单文件上限 100 MiB。
- 群聊不可用：bot 账号在微信里无法被拉进群，协议也没有群标识或出站群目标。出站原生定位、原生按钮和出站语音同样不支持。
- 真机排障先看 `logs/plugin-*.log`；协议探针为 `scripts/probe-login.ts`。

## 参与开发

```bash
npm ci
npm run typecheck && npm test && npm run build
```

目录职责、代码放置规则和提交约定见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [docs/structure.md](docs/structure.md)。改动消息收发路径前，请先读 [docs/design.md](docs/design.md) 里的收发不变量。

## 安全

这个插件能让一个聊天账号驱动本机 agent。默认 `cordis.patch.yml` 的权限档位是 `danger-full-access`，且只有白名单里的账号能驱动机器人（留空时只有扫码登录的那个号）。完整威胁模型、敏感数据位置和泄露后的处置步骤见 [SECURITY.md](SECURITY.md)。漏洞请走 GitHub Security Advisories，不要开公开 issue。

## 许可与致谢

更多说明见 [docs/README.md](docs/README.md)。协议实现参考腾讯 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 与 MIT 项目 [dsh-channel-wechat](https://github.com/wangx-wx/dsh-channel-wechat)，署名见 [NOTICE.md](NOTICE.md)。MIT 许可见 [LICENSE](LICENSE)。
