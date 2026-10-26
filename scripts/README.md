# scripts/

都是一次性/运维脚本，不参与插件运行时；插件本体不会 import 这里的东西（除 `png.ts` 被登录脚本用）。

| 脚本 | 什么时候用 | 副作用 |
|---|---|---|
| `login.ts` | 首次登录、登录过期、换号 | 写 `~/.dsh/wechat-persona/account.json`（0600） |
| `probe-login.ts` | 怀疑协议端点/请求头不对时 | 无（只取一张码、查一次状态，不写盘） |
| `png.ts` | 被 `login.ts` 用来把二维码画成 PNG | 无 |

## 登录

```bash
npm run login                                        # 终端里显示 ASCII 二维码
node --experimental-strip-types scripts/login.ts --png /tmp/qr.png   # 同时写图片
node --experimental-strip-types scripts/login.ts --data-dir /tmp/x   # 写到别处
node --experimental-strip-types scripts/login.ts --code-file /tmp/code.txt
```

- `--png <path>`：把二维码写成图片，方便贴到聊天窗口里扫
- `--code-file <path>`：非交互环境（没有 TTY）时，从文件读验证码；脚本每秒看一次，最多等 5 分钟
- 登录成功后**正在运行的 DSH 会在几秒内自动接上**（插件监听 `account.json`）

## 连通性探针

```bash
node --experimental-strip-types scripts/probe-login.ts
```

成功输出二维码 URL 和一次状态查询（`wait`）。它不写凭据，二维码几分钟后自然过期。
用途：确认「请求头 / `bot_type=3` / 端点 / 响应解析」这一层没有因为协议变更而坏掉。
