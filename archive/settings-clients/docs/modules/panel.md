# 已归档：独立设置服务与微信小程序

本说明保留历史安装与部署方式。当前插件使用微信文本菜单，不启动本服务。下面的命令需在 `archive/settings-clients/` 下运行；概况和检查步骤见 [../../README.md](../../README.md)。

最终手机入口采用 `miniprogram/` 原生小程序，网页保留给电脑和浏览器。两端共用 `SettingsRepository`、同一套权限与版本检查，DSH 只负责 bot 实时能力。

## 生命周期

`node lib/settings.js serve` 是独立 Node 进程，不导入 DSH 服务。默认固定端口 `32741`，配置写在运行数据目录 `settings/service.json`。macOS 使用 `settings install` 注册用户 LaunchAgent，登录电脑后自动启动，完全退出 DSH 不会关闭设置页。电脑关机或休眠时本机服务仍不可达；真正全天在线需要长期在线的部署主机。

```bash
npm run build
npm run settings:install -- --shortcut "$HOME/Desktop/设置.webloc"
npm run settings -- open
```

本机可用 `http://127.0.0.1:32741/persona-wechat/panel`，安装时会记录 Bonjour 主机名，手机同网可用固定 `.local` 地址。没有公网接入时仅支持本机和同一网络，不生成临时随机公网域名。

配置已有 HTTPS 反向代理：

```bash
node lib/settings.js configure --public-url https://你的设置域名
launchctl kickstart -k gui/$(id -u)/com.wechat-persona.settings
```

公网域名和 TLS 应由实际部署环境提供；不能仅写一个配置就声称外网已经连通。小程序 AppID、HTTPS 域名接入步骤见 [../../miniprogram/README.md](../../miniprogram/README.md)。

## 登录与权限

固定页面地址不携带凭据。首次在 bot 获取 8 位绑定码或一次性登录链接，也可通过 `node lib/settings.js pair` 从本机生成。绑定票据十分钟有效、一次消费，链接中的票据在 fragment 内，页面交换后清除。

网页使用 90 天 HttpOnly、SameSite cookie，小程序使用独立设备 bearer token。磁盘只保存 token 摘要，服务重启保留登录。设备可以查看与撤销；管理员可以管理全部设置，普通联系人只管理自身数据。浏览器写入校验自定义请求头和 Origin，所有私有响应禁止缓存。

HTTP 根页面、桌面 manifest、图标和离线说明公开；记忆、图片、设置和设备接口都必须认证。service worker 不缓存个人数据。小程序原图通过带认证的 downloadFile 获取，不制作公开图片 URL。

## 数据与 bot 控制

网页和 bot 共享原有数据目录。`storage/lock.ts` 按文档实施跨进程事务，记忆每次读取最新原子快照，写入前重新读取、检查版本。聊天部分修改和表情目录也在事务内提交。旧记忆没有来源时仍保留为未核实资料，人工新增不伪造原话。

DSH 插件只注册 `settings/host.sock`，提供在线状态和新对话 / 压缩 / 停止；设置服务通过私有 Unix socket 调用。网页服务自身的 `control.sock` 负责本机配对。两个 socket 均为 0600，不将 DSH API 暴露到局域网。

Bot 离线时，设置照常保存；对话控制不可用。Bot 上线后读取最新人格、记忆、表情和聊天设置。

## 代码

| 文件 | 职责 |
|---|---|
| `repository.ts` | 与宿主无关的数据校验与动作 |
| `service.ts`、`main.ts` | 常驻服务装配、CLI、LaunchAgent |
| `config.ts` | 固定端口、公开域名与本机地址 |
| `auth.ts` | 一次绑定、长期会话、设备撤销 |
| `server.ts`、`http.ts` | HTTP、请求边界、联系人权限 |
| `rpc.ts`、`register.ts` | 私有 socket、DSH 实时控制桥 |
| `assets.ts` | 桌面图标、manifest 和不缓存数据的 worker |
| `page.ts`、`client.ts`、`auth-client.ts`、`styles.ts` | 自包含网页 |
| `guide.ts` | 网页与小程序共用帮助 |

测试覆盖多进程并发、崩溃恢复、版本冲突、登录持久化、撤销、浏览器与原生客户端隔离。微信开发者工具编译、正式域名和真机访问仍需对应环境。
