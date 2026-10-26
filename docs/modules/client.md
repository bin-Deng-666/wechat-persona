# client/

浏览器端配置页（DSH bundle 的 client half）。手写 JS，由 `scripts/copy-client.mjs` 原样拷进 `lib/`。

页面分三块：

1. **连接**：二维码、扫码状态、登录的微信号、退出登录
2. **人格**：卡片列表、编辑、用固定上下文预览渲染结果
3. **聊天**：每个 peer 的设置（选人格、开关、温度覆盖、上下文条数）

页面路由统一挂在 `/api/persona-wechat/*`，复用宿主的 token fence——
注册在 `/api` 之外的路由任何本机进程都能访问。
