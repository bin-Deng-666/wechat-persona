# 目录与依赖边界

目录按长期职责划分。公共入口、宿主装配、微信交互、协议、DSH 适配、持久状态和纯文本处理分别有明确归属。

## 项目根目录

```text
wechat-persona/
├── src/                    插件运行代码
├── test/                   对应模块的测试 + integration/
├── scripts/                终端登录与协议探针
├── docs/                   架构、协议、使用与验收说明
├── examples/personas/      人格卡示例，可直接复制使用
├── lib/                    构建产物，不入库
├── release/                打包产物，不入库
├── package.json
├── package-lock.json
├── cordis.patch.yml        DSH profile 注册与默认配置
├── tsconfig.json
├── tsdown.config.ts
├── README.md
├── NOTICE.md
└── LICENSE
```

`npm run pack` 把安装包写到 `release/`。旧开发版本的包不再保留：它们可以由对应的 git 提交重新构建。本地 DSH profile 的 `file:` 依赖会直接引用某个 `.tgz` 路径，因此根目录允许存在被 profile 引用的单个安装包；除此之外不堆放打包产物。

## 源码

```text
src/
├── index.ts                公开导出：Config、name、apply、Coordinator
├── app/
│   ├── plugin.ts           Cordis 安装、服务注入、卸载接线
│   ├── coordinator.ts      账号和通道生命周期、服务装配
│   ├── config.ts           插件配置 schema
│   ├── identity.ts         插件标识
│   └── logger.ts           文件日志
├── auth/
│   ├── credentials.ts      登录凭据落盘
│   ├── session.ts          登录流程和面板可读状态
│   ├── qr.ts               二维码 SVG 渲染
│   └── png.ts              二维码 PNG 编码，供终端脚本复用
├── wechat/
│   ├── channel.ts          轮询、消息合并、会话投递与出站事件
│   ├── controls.ts         命令和数字菜单执行
│   ├── commands.ts         中文/斜杠指令解析和回复文案
│   ├── menu.ts             设置卡片渲染和选项解析
│   ├── access.ts           联系人准入
│   └── typing.ts           输入状态
├── ilink/
│   ├── api.ts              API 请求、回执和错误分类
│   ├── types.ts            协议数据形状
│   ├── login.ts            取码和扫码状态请求
│   ├── login-machine.ts    登录状态机
│   ├── media.ts            CDN 下载、AES、入站媒体引用
│   ├── upload.ts           CDN 上传
│   ├── send-image.ts       图片发送
│   └── send-file.ts        文件发送
├── dsh/
│   ├── sessions.ts         创建、恢复、借用与释放宿主会话
│   ├── system-prompt.ts    会话作用域的系统提示词组装
│   ├── attachments.ts      媒体转换为 DSH 附件
│   ├── events.ts           最终 assistant/message 提取
│   └── approvals.ts        微信审批桥
├── chat/
│   ├── settings.ts         每个聊天独立设置
│   ├── generations.ts      对话代次
│   ├── memory.ts           记忆标记和持久化
│   └── activity.ts         最近活跃时间
├── persona/
│   ├── card.ts             人格卡类型、校验、归一化
│   ├── prompt.ts           人格提示词纯函数
│   └── store.ts            人格卡扫描与热加载
├── stickers/
│   ├── library.ts          原件、联系人目录、收藏与识别状态
│   └── markers.ts          表情标记解析与名字校验，纯函数
├── media/
│   ├── image.ts            通用图片格式识别
│   └── gif.ts              GIF 多帧合成和预览
├── reply/
│   ├── queue.ts            文字和表情发送队列、限流、重试和节奏
│   └── bubbles.ts          可选分条和长度规划
├── text/
│   ├── split.ts            长文切分与代码块闭合
│   ├── location.ts         定位标记转换为地图链接
│   └── digits.ts           全角数字归一化
└── panel/
    ├── routes.ts           HTTP 参数校验与响应
    ├── register.ts         将路由注册到宿主
    └── page.ts             现有单文件 HTML 渲染，不设独立前端构建
```

## 放文件的规则

| 改什么 | 放哪里 |
|---|---|
| 新增微信指令或菜单项 | `wechat/commands.ts`、`menu.ts`、`controls.ts` |
| 改轮询、连发合并或消息路由 | `wechat/channel.ts` |
| 变更 iLink 字段、加解密、上传或回执 | `ilink/` |
| 变更 DSH 会话 API 或事件形状 | `dsh/` |
| 新增每个聊天的持久状态 | `chat/` |
| 调整人格卡及其文本渲染 | `persona/` |
| 表情管理与素材标记 | `stickers/` |
| GIF/图片格式能力 | `media/` |
| 分条、节流、发送顺序或重试 | `reply/` |
| 通用文字转换 | `text/`，不要依赖磁盘或宿主 |
| 网页页面、路由、参数验证 | `panel/` |
| 装配服务与管理通道生命周期 | `app/` |

`app/` 是装配层，允许访问各模块。`wechat/` 驱动对话流程，`dsh/` 处理宿主接口，`ilink/` 处理微信协议。`persona/`、`chat/`、`stickers/` 管理各自数据。`media/`、`text/` 是通用处理模块。

表情名字和控制标记解析不依赖 `StickerLibrary` 的文件 IO。图片格式识别不依赖 iLink。DSH 的最终事件形状由 `dsh/events.ts` 解码，回复队列不负责理解宿主日志。

`src/` 不导入 `scripts/` 或 `test/`。脚本单向复用源码。只有 `src/index.ts` 聚合公共 API；内部文件直接引用职责所属模块，不保留旧路径转发文件，也不为每个目录添加无意义的 index.ts。

## 测试与开发

`test/app/`、`auth/`、`chat/`、`dsh/`、`ilink/`、`media/`、`panel/`、`persona/`、`reply/`、`stickers/`、`text/`、`wechat/` 对应各自模块。跨系统提示词组装和完整微信对话的用例位于 `test/integration/`。

混合测试按职责拆分，例如登录状态机不混在 API 请求测试里，图片魔数不混在 CDN 测试里，表情文本标记不混在图片上传测试里。迁移保留原有断言和用例数量。

```bash
npm run typecheck
npm test
npm run build
npm run pack
# 只检查某类模块：
node --test --experimental-strip-types "test/wechat/*.test.ts"
```

类型检查包括源码、脚本和测试。测试命令递归匹配测试文件，避免调整目录后漏跑。

运行时数据目录的格式保持原有约定，见 [../README.md](../README.md)。本次整理不迁移账号、聊天记录、记忆或表情原件。
