import { COMMANDS } from '../wechat/commands.ts'
export const settingsGuide = {
  commands: COMMANDS,
  questions: [
    {title:'以后怎么打开？',answer:'小程序绑定一次后，从微信下拉“最近使用”或“我的小程序”打开。网页可收藏固定入口或添加到手机桌面，服务重启不会清除设备登录。'},
    {title:'Bot 离线还可以设置吗？',answer:'可以。独立设置服务保存人格、记忆、表情和聊天偏好，Bot 上线后读取最新设置。新对话、压缩、停止等实时操作需要 Bot 在线。'},
    {title:'新对话会清空记忆吗？',answer:'不会。新对话开启新的上下文，历史与个人记忆保留。记忆可在设置中单独修改或删除。'},
    {title:'怎么添加表情？',answer:'在微信给 bot 发图，图片会进入表情库。有名称且状态为“可用”时，bot 才会按语境发送。'},
    {title:'模型与群聊支持',answer:'模型在 DSH 桌面端切换。当前机器人账号只支持单聊，不能加入微信群。'},
  ],
}
