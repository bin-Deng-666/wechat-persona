# 网页配置面板

面板是服务端渲染的单文件 HTML，代码在 `src/panel/`，没有独立浏览器 bundle、静态复制脚本或前端依赖链。

| 文件 | 职责 |
|---|---|
| `page.ts` | 内联 HTML/CSS/JS 的页面渲染，接收路由前缀 |
| `routes.ts` | 校验 HTTP 输入、调用 PanelHandlers、返回 JSON/HTML |
| `register.ts` | 向宿主注册 /api 路由和独立 Web 入口，管理撤销函数 |

页面包含登录状态、二维码与验证码、人格卡读写，以及聊天的人格选择和启用状态。实际动作通过 `PanelHandlers` 接口交给 `app/coordinator.ts`。

`/api/persona-wechat/*` 受宿主认证保护。桌面版 Electron cookie 不能从普通浏览器取得，因而终端 `npm run login` 仍是桌面登录入口。独立 Web 宿主可使用 `/persona-wechat/*`，入口由进程级随机密钥保护；桌面 HTTP 转发规则不支持它时仍会返回 404。

扫码状态与凭据保存在 `auth/` 模块，不属于网页页面。微信内数字卡片属于 `wechat/menu.ts` 与 `wechat/controls.ts`，与网页面板独立。

测试见 `test/panel/routes.test.ts` 和 `test/app/plugin.test.ts`。
