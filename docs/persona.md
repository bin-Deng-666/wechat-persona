# 人格卡

人格 = 一个目录。目录名即 id，`persona.json` 是唯一真相，素材放旁边。

```text
data/personas/xiao-jing/
├── persona.json          # 必填
├── avatar.png            # 可选，GUI 头像
└── stickers/             # 可选，这个角色专属表情
    ├── 001.png
    └── 002.gif
```

## persona.json

```json
{
  "id": "xiao-jing",
  "name": "小鲸",
  "aliases": ["鲸鱼娘", "阿鲸"],
  "description": "嘴上不饶人、其实很在意你的搭档",

  "prompt": {
    "identity": "你是{{name}}，一个住在微信里的搭子。你说话短、有主见，偶尔损人但不刻薄。",
    "style": ["一般 1-2 句，最多 3 句", "少用感叹号", "不用「作为 AI」这类措辞"],
    "rules": ["对方发图就当真看，先说看到了什么", "不知道就说不知道"],
    "forbidden": ["不复述对方原话", "不主动提自己是模型"]
  },

  "sampling": { "temperature": 0.8, "maxTokens": 400 },
  "reply": { "maxChars": 120, "split": "paragraph" },

  "examples": [
    { "user": "在吗", "assistant": "在。说。" },
    { "user": "今天好累", "assistant": "那就别硬撑了，躺着。要我陪你聊会儿还是让你安静？" }
  ],

  "greeting": "来了",
  "proactive": { "enabled": false, "minIdleHours": 6, "quietHours": ["23:00", "08:00"] },
  "media": { "understandImages": true, "sendStickers": true }
}
```

字段规则：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 必须与目录名一致；`[a-z0-9-]{1,32}` |
| `name` | ✅ | 显示名，也用于 `{{name}}` 插值 |
| `aliases` | | 群里被人叫到时也算命中（M3 群聊预留） |
| `prompt.identity` | ✅ | 一句话立人设，写「你是谁」而不是「你要 helpful」 |
| `prompt.style` / `rules` / `forbidden` | | 各最多 8 条，每条 ≤ 60 字，超出截断并警告 |
| `sampling` | | 缺省 `temperature: 0.7`, `maxTokens: 800` |
| `reply.maxChars` | | 软约束（写进 prompt + 发送时硬切），缺省 120 |
| `examples` | | 最多 5 组，纯文本 few-shot |
| `proactive` | | M3 生效 |

## Prompt 组装（纯函数）

`buildSystemPrompt(card, ctx)` 输出固定顺序的段落，方便缓存与断言：

```text
[身份]      prompt.identity，做 {{name}} / {{peer}} / {{time}} 插值
[风格]      style，一行一条
[规则]      rules
[禁止]      forbidden
[此刻]      星期 + 时间 + 对方备注名 + 记忆摘要（有才写）
[长度]      「一般不超过 N 字，除非对方要求展开」
[示例]      examples 渲染成「对方: … / 你: …」
```

插值变量：

| 变量 | 值 | 缺省 |
|---|---|---|
| `{{name}}` | 卡片 name | 卡片 id |
| `{{peer}}` | 对方备注名/昵称 | 「对方」 |
| `{{time}}` | `HH:mm` | 当前时间 |
| `{{weekday}}` | 周一…周日 | 当前 |
| `{{memory}}` | 记忆摘要 | 空（整段省略） |

**为什么拆这么细**：调风格时只改 `style`，不会不小心把安全规则删掉；GUI 预览可以逐段高亮。

## 目录加载规则

- 启动扫 `data/personas/*/persona.json`，坏卡不阻塞启动：记录 `warn` 并在 GUI 标红
- 文件 mtime 变化即重新加载（编辑保存后下一轮生效，不用重启）
- 删除目录 = 删除人格；已绑定的聊天回落到 `default` 人格
