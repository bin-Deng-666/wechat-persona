# iLink 协议

`src/ilink/` 负责微信协议，不依赖 DSH 会话、人格、网页和回复队列。

| 文件 | 职责 |
|---|---|
| `api.ts` | 请求头、JSON 请求、回执验证、HTTP/业务/网络错误分类 |
| `types.ts` | 消息项、媒体引用、更新响应等线上形状 |
| `login.ts` | 获取二维码、轮询扫码状态、解析登录响应 |
| `login-machine.ts` | 登录状态转换、验证码、过期、重定向分支 |
| `media.ts` | 提取入站媒体引用、CDN 下载、AES 加解密 |
| `upload.ts` | 申请上传、加密上传、回执校验和上传重试 |
| `send-image.ts` | 上传图片后发送消息项 |
| `send-file.ts` | 上传文件后发送消息项与文件名处理 |

二维码渲染、用户可读的登录流程和凭据文件属于 `auth/`。通用图片格式识别在 `media/image.ts`，GIF 预览在 `media/gif.ts`。

请求错误在这里分类；长轮询退避由 `wechat/channel.ts` 控制，文字和表情发送退避由 `reply/queue.ts` 控制。CDN 上传有其自身的有限重试逻辑。

协议字段和已知边界见 [../protocol.md](../protocol.md)，对应测试在 `test/ilink/`。
