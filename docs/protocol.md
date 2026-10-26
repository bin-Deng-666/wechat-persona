# iLink 协议笔记

> 来源：腾讯官方 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 的
> `docs/protocol_zh_CN.md`，以及社区实现 [weixin-ClawBot-API](https://github.com/codeenxi/weixin-ClawBot-API)
> 与 [dsh-channel-wechat](https://github.com/wangx-wx/dsh-channel-wechat) 的实测记录。
> 本文只记录本项目用到的部分；官方文档为准，冲突时以官方为准。

## 服务

- Base：`https://ilinkai.weixin.qq.com`
- CDN：`https://novac2c.cdn.weixin.qq.com/c2c`
- 客户端类型：`bot`

## 请求头

| Header | 值 |
|---|---|
| `Content-Type` | `application/json` |
| `AuthorizationType` | `ilink_bot_token` |
| `Authorization` | `Bearer <bot_token>` |
| `X-WECHAT-UIN` | 随机 uint32 十进制字符串，再 base64（每次请求重新生成） |
| `iLink-App-Id` | `bot` |
| `iLink-App-ClientVersion` | `0x00MMNNPP` 编码的十进制字符串 |
| `SKRouteTag` | 可选路由标签 |

## 接口

| 操作 | 方法与路径 | 说明 |
|---|---|---|
| 取更新 | `POST /ilink/bot/getupdates` | 长轮询，服务端 hold 约 35s |
| 发消息 | `POST /ilink/bot/sendmessage` | 文本/图片/文件 |
| 取上传参数 | `POST /ilink/bot/getuploadurl` | 媒体上传 |
| 取配置 | `POST /ilink/bot/getconfig` | 含 `typing_ticket` |
| 输入状态 | `POST /ilink/bot/sendtyping` | `1` 开始 / `2` 取消 |
| 启动通知 | `POST /ilink/bot/msg/notifystart` | |
| 停止通知 | `POST /ilink/bot/msg/notifystop` | |

## 登录

```text
POST /ilink/bot/get_bot_qrcode?bot_type=3   body: { local_token_list: [] }
GET  /ilink/bot/get_qrcode_status?qrcode=<值>[&verify_code=<值>]
```

状态机：`wait` → `scaned` → `confirmed`；分支：`expired`、`need_verifycode`、
`verify_code_blocked`、`scaned_but_redirect`（切 `redirect_host`）、`binded_redirect`（已绑定其他实例）。

`confirmed` 返回 `bot_token`、`ilink_bot_id`、`baseurl`、`ilink_user_id`。

**会话会过期**：`errcode -14` 表示 bot token 失效 → 暂停并提示重新扫码（官方实现是冷却 1 小时），
不要盲目重试。

## 消息模型

`WeixinMessage`：`message_id`、`from_user_id`、`to_user_id`、
`message_type`（1 用户 / 2 Bot）、`message_state`（0 新 / 1 生成中 / 2 完成）、
`item_list`、`context_token`、`run_id`。

`MessageItem.type`：`1` text / `2` image / `3` voice / `4` file / `5` video /
`11` tool_call_start / `12` tool_call_result。

**没有的东西**（别照着「微信有的都能发」去设计）：

| 想做 | 结论 |
|---|---|
| 发定位 | 没有位置消息项，只能发「名字 + 地图链接」文本 |
| 发语音 | 有 `type: 3`，但两套参考实现都只收不发；编码（silk/amr）与时长字段没有样本，未验证 |
| 按钮卡片 | 没有模板消息/按钮/菜单，机器人只能发文本与媒体 |
| 引用回复 | 入站带 `quote.message_id`，出站没有对应字段 |

文件发送的两套编号别弄混：`MessageItem.type = 4`，而 `getuploadurl` 的 `media_type = 3`；
并且文件 `aes_key` 是「hex 字符串」的 base64，图片才是 16 字节原样的 base64。

### 发文本的必填结构

缺字段的表现是 **HTTP 200 但不投递**（静默丢消息），所以逐字段核对：

```json
{
  "msg": {
    "from_user_id": "",
    "to_user_id": "<用户ID@im.wechat>",
    "client_id": "wechat-persona-<随机hex>",
    "message_type": 2,
    "message_state": 2,
    "context_token": "<本轮回传，必须来自当前这条入站消息>",
    "item_list": [{ "type": 1, "text_item": { "text": "..." } }]
  },
  "base_info": { "channel_version": "1.0.2" }
}
```

## 媒体

- 上传：明文 MD5 → 16 字节 AES key + filekey → `getUploadUrl` → AES-128-ECB/PKCS#7 加密 →
  `POST` 密文 → 取响应头 `x-encrypted-param`
- 下载：优先 `full_url`，否则 `<cdn_base>/download?encrypted_query_param=<URL编码>`
- 图片 key：优先 `image_item.aeskey`（32 位 hex），其次 `media.aes_key`
- 成功判定：HTTP 200 **且** `x-encrypted-param` 非空；4xx 立即终止，其他失败最多重试 3 次

## 我们踩过 / 要守住的坑

1. `context_token` 必须用当前消息的值，复用旧 token 会静默失败
2. 长文本整条发送会被服务端拒绝 → 按段落切分，逐条发
3. `ret: -2` 是限流 → 2s → 4s → 8s → 16s 退避，不是重试三次就丢
4. 长轮询超时设 35s，短于服务端 hold 时间会空转
5. 协议只描述「官方插件怎么用」，不代表完整服务端契约，边界行为要实测

## 群聊

当前协议没有可靠的群消息语义，**本项目不做群聊**。宁可少一个功能，
也不猜一个会让消息错投的字段。
