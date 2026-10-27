# 目录与依赖边界

当前产品是运行在 DSH 内的微信单聊插件。用户在微信发送中文指令，插件回复简洁的文本菜单；网页、小程序与独立设置服务已归档。

## 文件树

```text
wechat-persona/
├── src/                         当前插件源码
│   ├── index.ts                 公共导出，不放业务逻辑
│   ├── app/
│   │   ├── plugin.ts            Cordis 安装、服务注入和卸载
│   │   ├── coordinator.ts       账号、通道生命周期与领域服务装配
│   │   ├── config.ts            插件配置 schema
│   │   ├── identity.ts          插件标识
│   │   └── logger.ts            文件日志
│   ├── wechat/
│   │   ├── channel.ts           轮询、入站调度、合并和宿主事件路由
│   │   ├── commands.ts          中文/斜杠指令解析、帮助和操作回执
│   │   ├── menu.ts              菜单视图、编号解析、选项到动作的映射
│   │   ├── controls.ts          菜单会话、有效期、命令与动作执行
│   │   ├── access.ts            联系人准入
│   │   └── typing.ts            输入状态
│   ├── auth/
│   │   ├── credentials.ts       登录凭据读写
│   │   └── png.ts               终端二维码 PNG 编码
│   ├── ilink/                   API、协议类型、登录状态机、CDN/AES、媒体收发
│   ├── dsh/                     宿主会话、系统提示词、附件、事件、审批、工作区与压缩
│   ├── chat/
│   │   ├── conversation.ts      联系人活动、输入顺序与输出取消
│   │   ├── history.ts           原始消息、提交批次、交付与任务快照
│   │   ├── settings.ts          聊天设置持久化
│   │   ├── generations.ts       新对话代次
│   │   └── activity.ts          最近活跃时间
│   ├── memory/                  分类、原话证据、检索、写入策略与持久化
│   ├── persona/                 人格卡类型、校验、热加载与提示词
│   ├── stickers/                表情原件、联系人目录、收藏与标记解析
│   ├── media/                   图片格式识别和 GIF 预览
│   ├── reply/                   发送规划、文字/表情/文件队列、重试与取消
│   ├── text/                    长文切分、数字归一化和定位链接
│   └── storage/
│       ├── atomic.ts            私有文件原子发布与进程内串行变更
│       └── lock.ts              跨进程文件事务与崩溃锁恢复
├── test/                        镜像模块目录；integration/ 为跨模块场景
│   ├── wechat/menu-flow.test.ts 中文入口、返回、过期、确认与停止压缩
│   └── storage/lock.test.ts     真实子进程的并发与崩溃恢复
├── scripts/
│   ├── login.ts                 终端扫码登录
│   ├── probe-login.ts           协议诊断，不写凭据
│   └── evaluate-conversation.ts 对话质量评估
├── archive/
│   └── settings-clients/        网页、小程序、服务端、测试及接入快照
├── docs/                        当前架构、模块、协议和验收说明
├── examples/personas/           可公开的人格示例
├── lib/                         当前构建产物，不入库
├── release/                     当前安装包，不入库
├── package.json                 当前插件命令、依赖和发布文件白名单
├── package-lock.json
├── cordis.patch.yml             DSH profile 注册与默认配置
├── tsconfig.json                只检查 src/、scripts/、test/
└── tsdown.config.ts              只构建 src/index.ts
```

## 命名与职责

文件名采用小写单词与连字符，例如 `system-prompt.ts`、`login-machine.ts`。目录按长期职责划分，不按页面或临时开发阶段分组。只保留 `src/index.ts` 作为公共导出入口，内部直接导入实际模块，不加旧路径转发文件。

微信交互的三个文件分别承担不同职责：`commands.ts` 解析触发词并提供帮助与回执；`menu.ts` 是无 IO 的视图和选项映射；`controls.ts` 维护菜单状态并调用领域仓库。`channel.ts` 只调度控制消息和正常聊天，不实现页面或数据 CRUD。

`app/coordinator.ts` 直接装配 `PersonaStore`、`ChatSettingsStore`、`PeerMemory`、`StickerLibrary`，不通过网页仓库创建核心服务。账号登录使用终端脚本和凭据文件监听；插件不创建 HTTP 服务、Unix 控制 socket 或后台 LaunchAgent。

## 依赖方向

- `app/` 装配各模块；`wechat/` 调度交互，`dsh/` 适配宿主，`ilink/` 适配协议。
- `persona/`、`chat/`、`memory/`、`stickers/` 管理各自领域数据，通用持久化放在 `storage/`。
- `media/` 与 `text/` 不依赖 DSH、菜单或网页；表情标记解析不依赖文件 IO。
- 当前 `src/` 不导入 `archive/`、`scripts/`、`test/`。归档可单向复用当前领域模块。
- 归档有独立的类型检查、测试和构建命令。默认 `npm test`、`npm run build` 和安装包文件白名单排除归档。

## 代码放置

| 改动 | 文件或目录 |
|---|---|
| 中文触发词和帮助内容 | `wechat/commands.ts` |
| 菜单布局、编号和返回映射 | `wechat/menu.ts` |
| 菜单状态与操作执行 | `wechat/controls.ts` |
| 入站、合并、停止和事件路由 | `wechat/channel.ts`、`chat/conversation.ts` |
| 宿主 API 与工具能力 | `dsh/` |
| 微信协议与回执 | `ilink/` |
| 个人记忆和原话证据 | `memory/` |
| 当前任务快照、交付历史 | `chat/` |
| 文件原子写入与并发锁 | `storage/` |
| 网页与小程序历史实现 | `archive/settings-clients/` |

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run pack
```

测试按职责组织。通用文件锁测试放 `test/storage/`，不随网页一起归档。运行数据只保存在用户的数据目录，归档和目录调整均不复制或清空真实人格、记忆、表情、账号和聊天记录。

微信交互约定见 [modules/wechat.md](modules/wechat.md)，收发不变量见 [design.md](design.md)，归档恢复方式见 [../archive/settings-clients/README.md](../archive/settings-clients/README.md)。
