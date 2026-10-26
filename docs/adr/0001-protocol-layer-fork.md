# ADR 0001：协议层以 dsh-channel-wechat 为基线，产品层重写

- 状态：已接受
- 日期：2026-10-26

## 背景

要做「微信里的 AI 联系人」，绕不开协议层。可选：

1. 从零按腾讯 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 的协议文档实现
2. 以 MIT 的 [dsh-channel-wechat](https://github.com/wangx-wx/dsh-channel-wechat) 为基线
3. 依赖它的 npm 包，自己只做上层

## 决策

**协议层参考基线、产品层重写。**

- `src/ilink/` 按官方协议文档实现；遇到边界行为（字段必填性、限流、长文拒绝）时，
  以 dsh-channel-wechat 的实现与它的 `docs/recon/` 记录为参照，改编处保留 MIT 署名
- `src/persona/`、`src/bridge/` 完全自己写，不复制对方的 bridge 逻辑
- 不把 `dsh-channel-wechat` 作为运行时依赖：两个插件同时装会抢同一个 iLink 会话，
  且它的会话代次、命令集、审批卡策略与我们的 per-chat 人格模型冲突

## 理由

- **从零写的代价**：协议本身不难（七个接口），难的是踩过的坑——一轮只发最终回答、
  `context_token` 不复用、长文整条被拒、`ret: -2` 的退避节奏。这些用文档换不来
- **直接依赖的代价**：它的 `bridge/` 假设「一个 bot 一个主人」，没有 per-chat 人格、
  没有记忆、没有表情包；改它等于 fork，不如分层重写
- **MIT 允许**：保留版权声明即可，不影响闭源分发（本插件自己也是 MIT）

## 后果

- 好：协议层能快速到位，产品层不受对方设计约束
- 好：两个插件可选择装哪一个，不会互相污染会话
- 坏：协议升级时要自己跟（官方有 `channel_version` 门禁，版本不符会明确报错而不是静默降级）
- 风险：与 dsh-channel-wechat 同时登录同一微信号会互相踢；README 里要写清楚

## 备选与否决

- **依赖 dsh-channel-wechat 做通道、另写一个「提示词改写」插件叠加**：否决。
  per-chat 人格需要在会话创建前决定 prompt，叠加插件拿不到这个时机。
- **独立 sidecar + Thin DSH 插件**：推迟。首版跑在进程内更简单；等需要脱离 DSH 时再拆。
