# 路线图

每个里程碑都要能独立验收，不靠「后面再补」。

## M0 · 骨架（进行中）

- [x] 目录与分层
- [x] 构建配置（tsdown + tsc）
- [x] 设计文档、ADR、协议笔记
- [x] 配置 schema（`src/config.ts`，全 volatile 以便 GUI 可编辑）
- [x] 插件入口能空跑：`apply` 校验 cwd、扫人格目录、报告结果，不依赖任何宿主服务
- [x] `tsc --noEmit` 与 `tsdown` 构建通过；产物 `lib/index.js` 可被 Node 加载
- [ ] 装进 `desktop` profile 实测（需要完全重启 DSH，等 M1 有实际功能后再做）

**验收**：`pnpm build` 通过；装进 `desktop` profile 后 DSH 正常启动，Plugins 页能看到本插件。

## M1 · 通道打通

- [x] iLink：`get_bot_qrcode` / `get_qrcode_status` 登录状态机（含验证码分支）
- [x] 长轮询 `getupdates` + 游标持久化 + 去重
- [x] `sendmessage`（文本）+ 回执校验 + `ret: -2` 退避
- [x] `sendtyping` 输入状态（ticket 缓存 + 失败静默）
- [x] GUI：扫码页、登录态、退出登录、人格列表
- [x] `bridge`：peer → DSH 会话 → `agent.followup()` → 回复
- [ ] 真机验证：桌面版安装后扫码，微信收发通过
- [x] 在真实 DSH 运行时里装载通过（headless profile 冒烟：日志出现「已加载 cwd=… dataDir=…」）
- [x] 连通性探针：`node --experimental-strip-types scripts/probe-login.ts` 已对真实 iLink 跑通取码与状态查询

**验收**：微信发「你好」，DSH 回复原样回到微信；进程重启后不重复回复历史消息。

## M2 · 人格聊天

- [ ] 人格卡 schema + 校验 + 加载（目录即人格，热更新）
- [ ] `buildSystemPrompt` 纯函数 + 单测（变量插值、示例对话、字数约束）
- [ ] per-chat 设置：选人格、开关、覆盖温度、上下文条数
- [x] GUI：人格列表（编辑/预览待做）
- [x] 图片入站：CDN 下载 + 解密 → 附件 → 会话；不支持时降级成文字说明
- [x] 长文切分（含代码块闭合）
- [x] 「对方正在输入」对齐

**验收**：同一句话，换人格卡回复风格明显不同；发一张图能描述内容；超长回复不被截断。

## M3 · 表情与主动

- [ ] 表情包：**收集**（收到的表情入库）、描述生成（发送已支持 `[表情:名字]`）
- [x] 主动搭话：空闲 N 小时 + 不在免打扰时段 → 生成一句
- [ ] 记忆摘要：每天/每 N 轮压缩成短摘要，注入下次 prompt
- [ ] 用量与成本统计（按 peer）

**验收**：连续聊 3 天，第 4 天它记得第 1 天说过的事；主动消息频率不让人烦。

## 明确不做

- 群聊（协议不支持）
- Windows Hook / 数据库解密（违规且不可移植）
- 多账号、主动推送陌生人、营销群发
