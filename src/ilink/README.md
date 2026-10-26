# ilink/

iLink 协议层。只关心「怎么把一条消息正确收发」，不关心谁在回、回什么。

计划文件（M1）：

| 文件 | 职责 |
|---|---|
| `api.ts` | 七个接口的薄封装：`getupdates` / `sendmessage` / `getconfig` / `sendtyping` / `getuploadurl` / `notifystart` / `notifystop` |
| `qr.ts` | 取二维码 + 轮询状态，含验证码与 `scaned_but_redirect` 分支 |
| `types.ts` | `WeixinMessage`、`MessageItem` 等线上形状 |
| `inbound.ts` | 把 `item_list` 归一化成「文本 + 媒体引用」 |
| `cdn.ts` / `cdn-upload.ts` | 媒体上传下载与 AES 加解密 |
| `errors.ts` | `ret: -2` 限流、`errcode -14` 会话过期等可判定错误 |

边界：错误分类在这里定，退避策略在 `bridge/` 用；协议层不 sleep、不重试。
