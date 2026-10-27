# 网页设置与微信小程序归档

当前产品入口是微信内的中文指令和设置菜单。本目录保留网页、小程序及服务端实现，供以后恢复或复用；主插件不导入本目录，默认构建、测试和安装包均不包含这些实现。

```text
settings-clients/
├── src/
│   ├── panel/            网页、HTTP API、设备认证、固定端口服务、CLI、Unix socket
│   ├── auth/             网页扫码登录状态与 SVG 二维码
│   ├── app/              归档时的插件装配与设置服务接线快照
│   ├── wechat/           带网页入口的微信控制代码快照
│   └── index.ts          历史插件入口
├── miniprogram/          原生微信小程序页面、API 客户端与配置
├── scripts/              小程序配置和静态检查
├── test/                 HTTP、认证、持久化、小程序和控制桥测试
├── docs/modules/panel.md 历史服务安装与部署说明
├── SECURITY.md           归档时的设备认证与公网部署安全说明
├── manifest.json         原路径、归档路径、迁移前 SHA-256 与快照类型
├── tsdown.config.ts      单独构建到本目录 lib/
├── tsconfig.json         单独类型检查，允许复用主项目领域模块
└── package.json          独立检查与构建命令
```

`src/app/`、`src/wechat/` 和 `src/index.ts` 是接入快照，不是另一套持续维护的插件。通用的人格、记忆、聊天设置、表情和文件事务仍复用主项目 `src/`，相对导入已随归档路径调整；不复制运行数据，也不保存真实账号、小程序密钥或登录凭据。

从仓库根目录安装主项目依赖后，可以单独检查归档：

```bash
npm --prefix archive/settings-clients run typecheck
npm --prefix archive/settings-clients test
npm --prefix archive/settings-clients run check:miniapp
npm --prefix archive/settings-clients run build
```

这些命令不安装后台服务，也不将归档重新接回当前插件。`lib/settings.js`、`src/panel/register.ts` 和历史装配快照保留恢复所需的入口。恢复时先对齐当前领域接口与权限校验，再决定客户端形式和服务部署；不要直接覆盖主项目的装配文件。

小程序保留占位 AppID 和空服务地址，正式运行仍需实际 AppID、HTTPS 域名、开发者工具编译和真机验证。历史使用说明见 [miniprogram/README.md](miniprogram/README.md) 与 [docs/modules/panel.md](docs/modules/panel.md)。

已安装过旧网页服务的机器可能仍有 `~/.dsh/wechat-persona/settings/`、LaunchAgent 或桌面快捷方式。源码归档不删除这些数据；停用后台服务与删除运行数据是不同操作。
