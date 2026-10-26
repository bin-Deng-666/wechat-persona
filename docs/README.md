# 文档索引

先读哪个，取决于你要干什么。

## 想用起来

| 文档 | 内容 |
|---|---|
| [../README.md](../README.md) | 安装、登录、微信内命令、数据目录 |
| [persona.md](persona.md) | 人格卡字段、prompt 组装规则、目录加载规则 |

## 想改代码

| 文档 | 内容 |
|---|---|
| [design.md](design.md) | 分层、数据流、6 条不变量、已知边界 |
| [modules/ilink.md](modules/ilink.md) | 协议层：文件职责、错误分类、退避策略归属 |
| [modules/bridge.md](modules/bridge.md) | 桥接层：会话映射、回复路径、准入 |
| [modules/client.md](modules/client.md) | 面板与客户端（含桌面版为何不可用的结论） |
| [protocol.md](protocol.md) | iLink 接口速查、必填字段、踩过的坑 |

## 想知道为什么这么定

| 文档 | 内容 |
|---|---|
| [adr/0001-protocol-layer-fork.md](adr/0001-protocol-layer-fork.md) | 为什么「协议层参考、产品层重写」，而不是直接依赖 |
| [roadmap.md](roadmap.md) | 里程碑、验收标准、明确不做的部分 |

## 排障

按顺序看：

1. `~/.dsh/wechat-persona/logs/plugin-*.log` —— 加载、轮询、发送失败都在这
2. `node --experimental-strip-types scripts/probe-login.ts` —— 协议连通性，不写凭据
3. `zstd -dc ~/.dsh/sessions/--Users-dengbin--/channel-persona-*/session.v4.jsonl.zstd`
   —— 会话里到底发生了什么（工具调用、回复、错误）
