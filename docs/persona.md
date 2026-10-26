# 人格卡

人格 = 一个目录。目录名即 id，`persona.json` 是唯一真相。

```text
data/personas/jarvis/
└── persona.json          # 必填，其余文件忽略
```

自定义人格不需要写代码：在 `data/personas/` 下新建一个目录，放一份 `persona.json` 即可。仓库里的 [examples/personas/jarvis/persona.json](../examples/personas/jarvis/persona.json) 可以直接复制来改。

## persona.json

```json
{
  "id": "jarvis",
  "name": "贾维斯",
  "description": "沉稳、精确、带一点英式冷幽默的 AI 管家（示例人格）",

  "prompt": {
    "identity": "你是{{name}}，一套沉稳、精确、略带英式冷幽默的智能管家。你称对方为「先生」，先给结论，再给必要的细节，不卖弄。",
    "style": [
      "一般 1-3 句，先给结论",
      "语气从容克制，偶尔一句干练的调侃",
      "技术问题给可执行步骤，不堆术语",
      "不用「作为 AI」这类措辞"
    ],
    "rules": [
      "不确定就直说，并给出验证方式",
      "涉及删除、覆盖或危险命令时，先说清后果再等确认",
      "对方发图就当真看，先说看到了什么"
    ],
    "forbidden": [
      "不复述对方原话",
      "不夸张吹捧",
      "不主动提自己是模型"
    ]
  },

  "reply": { "maxChars": 160, "split": "paragraph" },

  "examples": [
    { "user": "在吗", "assistant": "在。有什么事，先生？" },
    { "user": "今天好累", "assistant": "那就先停下。需要我把剩下的收个尾，还是留到明早？" },
    { "user": "帮我看看这个报错", "assistant": "把完整堆栈贴给我。只有最后一行的话，我只能猜。" }
  ],

  "media": { "sendStickers": true }
}
```

> 这份“贾维斯”是一份管家风格的原创写作，只用来演示字段怎么填，与任何影视作品无关。

字段规则：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 必须与目录名一致；`[a-z0-9-]{1,32}` |
| `name` | ✅ | 显示名，也用于 `{{name}}` 插值 |
| `description` | | 一句话简介，显示在网页面板的人格列表里 |
| `prompt.identity` | ✅ | 一句话立人设，写「你是谁」而不是「你要 helpful」 |
| `prompt.style` / `rules` / `forbidden` | | 各最多 8 条，每条 ≤ 60 字，超出截断并警告 |
| `reply.maxChars` | | 闲聊表达的字数目标，缺省 120；任务回答按需要完整表达，普通人格不据此强拆气泡 |
| `reply.split` | | `paragraph` / `sentence` / `none`，缺省 `paragraph` |
| `examples` | | 最多 5 组，纯文本 few-shot |
| `media.sendStickers` | | 是否把当前联系人的表情目录与识别指令写进系统提示词，缺省 `true` |

## 从零写一张

最小可用卡片只有三个必填项：

```json
{
  "id": "my-bot",
  "name": "小助手",
  "prompt": { "identity": "你是{{name}}，说话直接、简短，不客套。" }
}
```

保存到 `~/.dsh/wechat-persona/personas/my-bot/persona.json`，然后发“人格 my-bot”切换。其余字段会用默认值，`reply.maxChars` 缺省 120，`reply.split` 缺省按段落。

## 已移除的字段

写进这些字段不会生效，但会得到一条明确的警告，而不是被静默忽略：

| 已移除 | 原因 |
|---|---|
| `proactive` | 通道不做定时主动搭话 |
| `sampling` | 温度与输出上限由 DSH 会话决定，卡片里的值不生效 |
| `greeting` | 从未被使用 |
| `aliases` | 只对群聊有意义，本项目不支持群聊 |
| `media.understandImages` | 视觉能力按宿主和当前模型探测，不由人格卡声明 |

未知字段同样会记一条「不认识的字段，已忽略」。这些警告都不阻塞加载。

## 在会话中使用

人格通过当前 DSH agent 作用域的 `system-prompt/assemble` 进入真正的 system 提示词。每次请求读取当前卡片、聊天设置、记忆和表情目录；用户消息只包含微信原文和附件，不再有“首轮设定”或“继续扮演”提醒。

“人格 <id>”或“菜单 → 人格”切换后，下一次请求读取新卡片。修改文件也在下一次请求生效。模型参数（provider、model、推理强度、输出上限）由 DSH 会话决定，不在人格卡里配置。

## Prompt 组装（纯函数）

`buildSystemPrompt(card, ctx)` 输出固定顺序的段落，方便缓存与断言：

```text
[身份]      prompt.identity，做 {{name}} / {{peer}} / {{time}} 插值
[风格]      style，一行一条
[规则]      rules
[禁止]      forbidden
[此刻]      日期 + 星期 + 时间 + 对方标识 + 沟通习惯（有才写）
[表达长度]  闲聊字数目标；任务说明与必要解释按内容展开
[示例]      examples 渲染成「对方: … / 你: …」
```

表情目录和通道控制标记不在这里渲染：它们由 `src/dsh/system-prompt.ts` 在人格段落之后追加，并把卡片文本标记为 `interpolate: false`，避免记忆或人格里的字面花括号被宿主再次插值。

插值变量：

| 变量 | 值 | 缺省 |
|---|---|---|
| `{{name}}` | 卡片 name | 卡片 id |
| `{{peer}}` | 对方备注名/昵称 | 「对方」 |
| `{{time}}` | `HH:mm` | 当前时间 |
| `{{weekday}}` | 周一…周日 | 当前 |
| `{{memory}}` | 记忆摘要 | 空（整段省略） |

**为什么拆这么细**：调风格时只改 `style`，不会不小心把安全规则删掉；网页面板预览可以逐段高亮。

## 目录加载规则

- 启动扫 `data/personas/*/persona.json`，坏卡不阻塞启动：记录 `warn` 并在网页面板标红
- 文件 mtime 变化即重新加载（编辑保存后下一轮生效，不用重启）
- 删除目录 = 删除人格；已绑定的聊天回落到 `default` 人格
- 没有可用卡片时，首次启动会写入一张内置的 `default` 人格卡
