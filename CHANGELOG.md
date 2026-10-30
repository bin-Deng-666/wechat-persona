# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions before `0.2.0` are development builds and were never published.

## [Unreleased]

### Added

- 入站报文诊断：无法识别、或带未知字段的报文会记下形状（id、类型、未知字段名），
  不再静默丢弃；用 `diagnoseMessages` 可逐条记录。只记字段与 id，不记 `context_token`
  等凭据。
- Conversation evaluation accepts `--persona` and `--cases` for actual cards.
- 微信设置菜单：五个常用操作，支持中文分类入口、返回、关闭和清空记忆前确认；
  “帮助”直接回复完整中文指令与表情用法。
- 单文件产品介绍页 `docs/introduction.html`：首屏四张微信实机截图（可放大）、功能、
  中文指令、安装步骤与常见问题；零外部依赖，支持明暗主题与手机布局，可离线打开。
- 仓库清理：移除文档、测试与归档中的私人称呼和本机路径，归档小程序使用通用名称。
- 插件展示元数据：`locale/en.json` 与 `locale/zh.json` 提供 `meta.title` 和
  `meta.description`，`icons/dsh-wechat-persona.svg` 为原创矢量图标（对话气泡与人格脸，
  靛蓝到青色渐变，未使用任何第三方商标）。`package.json` 导出 `./locale/*.json` 与
  `./icon`，两项都进 `files`，插件管理器和设置页无需激活插件即可显示。

### Changed

- 微信设置、人格、记忆和表情菜单统一标题图标、分组留白和简短说明；帮助按常用入口、
  对话管理、表情用法分组。切换、收藏和对话操作使用统一回执，不向聊天暴露内部控制标记。
- 设置交互恢复为微信内的中文触发和编号菜单，简化为人格、记忆、表情、新对话和压缩。
  移除分条设置、网页入口及相关触发指令；正常聊天自动退出菜单，子菜单逐级返回。
- 网页、独立 HTTP 服务、小程序、认证与本机控制桥移至 `archive/settings-clients/`，
  保留源码、测试、脚本、文档和接入快照，提供独立检查与构建，不进入主插件安装包。
- 核心服务直接装配人格、聊天设置、记忆和表情仓库；移除网页服务注册和网页专用登录状态。
  真实子进程的事务测试归属 `test/storage/`，统一当前文件树、命名和依赖边界说明。
- 长任务进度提示不再发固定台词「还在处理，稍等一下。」：优先用模型自己这一步的旁白（它刚
  说过要做什么），其次按正在跑的工具说一句；两者都没有时不发，不让它变成一句无关的固定
  说辞。
- 报平安节奏改为 90 秒一句、最多 900 秒。人格卡 `progress` 的 10 条文案正好覆盖一轮，
  一轮内不重复；超过 900 秒的活交给卡住看门狗兜底。真实工具旁白仍会即时显示，不再靠
  密集的固定台词制造“有进展”的错觉。60 秒实测仍偏密：一轮连发 9 条后，紧接着的真答案
  撞上 `-2` 限流丢了。
- 投递优先级取代 `urgent` 布尔：`high` 是回答与文件，`normal` 是命令回执与菜单，`low`
  是报平安与进度旁白。限流重试预算按档位分开——`high` 12 次、退避上限 60 秒，`normal`
  维持 6 次、30 秒，`low` 零重试且遇到 `high` 在排队或正在发送时主动让路，不进队列、
  不占额度。报平安晚一秒没关系，烧掉的重试次数正是真答案发不出去的原因。
- 模型设置页每页 7 项，第一项固定为“跟随 DSH 默认”，8/9 翻页；人格页同样分页并标出
  当前人格。换模型优先在现有会话内热切换，保留上下文；宿主不支持时才回退到新会话，
  并在回复里明确说明。重复选中实际生效的模型不再重开会话。
- 设置页的 `cwd` 注明只影响新建会话，`dataDir` 注明需重启 DSH；字段都补充了 GUI 说明。
- 状态命令改为报告“本次运行已处理 N 轮”，不再把运行内计数说成跨重启的累计消息。

### Fixed

- 工具调用步骤不再被整体丢弃：模型写给用户的旁白会作为执行进展发到微信，只有工具名
  时用低频状态更新兜底；推理内容、命令参数、路径和工具输出不会外泄。
- 最终回答的发送结果不再静默：失败、结果不明和部分成功会立即告知用户，并可用「重试」
  只补发已保存的内容，不重新运行模型或工具。补发成功后原记录收口，避免重复重发。
- 正常结束但没有任何正文时明确说明，不再让用户对着空白等待。
- 单次发送增加 20 秒超时，相邻气泡间隔改为 2 秒，降低服务端 `-2 prepare failed` 的概率；
  `-2` 的退避预算改为按投递优先级分配，见上文。
- 长任务结束时改用最新入站 `context_token` 发送，而不是任务开始时的旧令牌；这正是长回答
  被 `-2 prepare failed` 拒绝的高风险来源。每次重试前都会重新取令牌。
- 发送失败提示改走独立的关键通道：限流时拥有更长的退避预算；若最终仍未送达，会写入持久
  上下文，由下一轮对话自然带出，不再彻底静默。报平安让路单独记一行日志，不算失败。
- 三套表情标记解析合并为一套 `splitStickerSegments`，发送顺序与名字校验只有一处实现；
  名字不合法时保留原文，不吞掉用户的字。
- 聊天设置目录改为联系人哈希。旧目录把 `%` 换成 `_`，含 `/`、`%` 等字符的 peer 会落到同一
  目录，可能读到或覆盖别人的设置；现在旧目录只在文档内 `peerId` 与联系人一致时读取，
  新写入落到哈希目录，旧文件保留供核对。设置文档损坏时报错并保留原件，不再静默回落默认值。
- 出站媒体的 `aes_key` 统一为「先写 32 位 hex 字符串、再对该字符串做 base64」。图片此前误用
  了 16 字节原样的 base64，收件人解不开密钥，微信里表现为「图片已过期」。图片、文件、视频
  现在共用同一种编码。
- 轮询游标只在真正前进时落盘。此前拿启动时的基线比较，长轮询每次返回都会判定为「变了」，
  `cursor.json` 被每 5 秒重写一遍，内容却从没变过；写盘同时改为原子发布，进程中途退出不会
  留下半个 JSON。

## [0.3.0-dev.0] - 2026-10-26

### Changed

- Rebuilt conversation handling around one activity per contact, ordered input
  preparation and DSH steering. Stop cancels pending output; new conversations
  reject late text, files and turn events from older generations.
- Text, stickers and files share a cancellable outbox. Each delivery has a stable
  retry ID and durable accepted/failed/unknown/cancelled status. Accepted means
  server acceptance, never recipient read acknowledgement.
- Compaction runs outside ingress and can be cancelled. Task snapshots preserve
  goals, latest constraints, completed work, pending work and questions across it.
- Removed random post-generation thinking delays. Chat bubble size no longer
  changes the requested depth of an entire answer.
- Escaped contact session IDs include a hash to prevent punctuation collisions;
  old legacy session logs are preserved and not automatically rewritten.

### Added

- Contact-scoped memory search/write tools with original user evidence, five
  memory categories, scope/certainty, version checks and deletion suppression.
  Domain/search/evidence logic is adapted from MIT agent-personal-memory.
- Durable input identity, restart recovery and delivery context for later turns.
- Real DSH tool-dispatch and lifecycle regressions, plus a fixed multi-turn
  headless evaluation runner that records blocked runs honestly.

### Migration

- Legacy memories without original evidence remain visible as unverified records;
  they are not automatically injected or promoted to trusted facts. Original
  files and old sessions are retained. No personal-memory data from pi is copied.

## [0.2.0-dev.0] - 2026-10-26

### Changed

- **Persona now enters the session system prompt.** Personality, memory and the
  sticker catalog are contributed through the agent-scoped
  `system-prompt/assemble` hook, and are re-read on every request. User messages
  carry only the WeChat text and attachments.
- Replies default to a single message. Multiple messages are only produced when
  the model explicitly marks a boundary with `[分条]`.
- Chinese commands are the primary entry point: 菜单/设置, 帮助, 新对话, 状态,
  人格, 分条, 停止, 表情. The original `/` commands still work.
- Sticker assets are stored by content hash and de-duplicated. Recognition and
  access are scoped per contact; a file can be shared while its catalog entry
  stays private.
- GIF originals are preserved and previewed to the model as up to three PNG
  frames instead of a single still.
- Source tree reorganized by responsibility (`app`, `auth`, `wechat`, `ilink`,
  `dsh`, `chat`, `persona`, `stickers`, `media`, `reply`, `text`, `panel`).
  Tests mirror the same layout.

### Added

- Session-scoped system prompt integration with hot reload of persona, chat
  settings, memory and sticker catalog.
- Optional multi-message replies that keep text and stickers in one ordered
  send queue with shared throttling and retry.
- Automatic sticker capture with model-confirmed name, description and usage
  scenes; screenshots, photos and documents can be explicitly ignored.
- Memory persistence through the `[记住: …]` marker, readable and clearable from
  the settings card.
- 压缩 command: forwards a manual session compaction to the host, replacing old
  history with one summary while keeping the original log. It reports the
  shadowed item and token counts, and answers explicitly when the agent is busy,
  the history is empty, or the host has no compaction service.
- Multi-frame GIF preview bounded by canvas, frame count and total decode size.
- Open source project files: CI workflow, issue and PR templates, Dependabot,
  contributing, security policy, code of conduct and this changelog.

### Removed

- Per-turn persona reminder prepended to user messages. Existing sessions keep
  the old text in their history; send 新对话 to start a clean context.
- Scheduled proactive messages, and the `proactive` persona field and per-chat
  toggle.
- Persona fields that never took effect: `sampling`, `greeting`, `aliases` and
  `media.understandImages`. Cards using them now get an explicit warning
  instead of being silently ignored.
- Historical development tarballs. Rebuild any old version from its commit.

### Fixed

- Long polling is cut short client-side so new messages no longer wait for the
  server hold to expire.
- The `context_token` of the inbound message is captured when a reply is queued,
  so later messages cannot overwrite it.
- Settings card actions answer with one confirmation line instead of sending a
  fresh card each time.

[Unreleased]: https://github.com/bin-Deng-666/wechat-persona/compare/v0.2.0-dev.0...HEAD
[0.2.0-dev.0]: https://github.com/bin-Deng-666/wechat-persona/releases/tag/v0.2.0-dev.0
