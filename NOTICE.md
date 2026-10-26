# 第三方声明

本项目以 MIT 许可发布。以下内容来自第三方，按各自许可使用。

## 协议实现参考

- **dsh-channel-wechat** — <https://github.com/wangx-wx/dsh-channel-wechat>
  MIT License，Copyright (c) wang.x。
  本项目的 iLink 协议层（`src/ilink/`）在实现时参考了该项目的协议处理与
  `docs/recon/` 中的边界记录。**改编自其代码的文件会在文件头保留上述版权与许可声明。**
  当前尚无直接改编：`src/ilink/` 按腾讯官方协议文档独立实现。

- **openclaw-weixin** — <https://github.com/Tencent/openclaw-weixin>
  MIT License，Copyright (C) 2026 Tencent。
  微信 Bot 通道（iLink）的官方开源实现与协议文档，本项目以其为规范来源。

## 产品设计参考

- **WeChatAgent** — <https://github.com/sourcepro5/WeChatAgent>
  其代码许可为 NOASSERTION（见该仓库 `LICENSES.md`），因此**本项目未复制其任何代码**，
  仅参考产品设计（聊天/助手分权、按聊天授权、人格卡与表情包的组织方式）。
  该项目的 Windows Hook 与数据库解密方案本项目不使用。

## 依赖

运行时依赖与开发依赖的许可证以 `package.json` 与锁文件为准；
打包产物中包含的第三方代码会在 `tsdown.config.ts` 的 banner 中保留其许可声明。
