/** 设置页输出为一份自包含 HTML；样式和交互分别维护，构建时一起内联。 */
import { COMMANDS } from '../wechat/commands.ts'
import { settingsGuide } from './guide.ts'
import { panelStyles } from './styles.ts'
import { panelClient } from './client.ts'
import { panelAuthClient } from './auth-client.ts'

const escapeHtml = (value: string): string => value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))
const paths: Record<string, string> = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>',
  memory: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4z"/><path d="M20 4h-4a3 3 0 0 0-3 3v14a4 4 0 0 1 4-2h3z"/>',
  stickers: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  personas: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 2-2.5 2-2.5 4M12 17h.01"/>',
  account: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 9h6M7 13h3"/><circle cx="17" cy="13" r="1"/>',
  theme: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  brand: '<rect x="4" y="6" width="16" height="14" rx="4"/><path d="M12 3v3M8 12h.01M16 12h.01M9 16h6"/>',
}
const icon = (name: string): string => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] ?? paths['chat']}</svg>`

export function renderPage(publicPrefix: string): string {
  const help = COMMANDS.map(command => `<div class="help-row"><code>${escapeHtml(command.usage)}</code><span>${escapeHtml(command.description)}</span></div>`).join('')
  const faq = settingsGuide.questions.map(item => `<details><summary>${escapeHtml(item.title)}</summary><p>${escapeHtml(item.answer)}</p></details>`).join('')
  const nav = (id: string, label: string, admin = false): string => `<a href="#${id}"${admin ? ' data-admin hidden' : ''}>${icon(id)}<span>${label}</span></a>`
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>微信 Bot · 设置</title>
<meta name="theme-color" content="#18181b"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="设置">
<link rel="manifest" href="${publicPrefix}/manifest.webmanifest"><link rel="apple-touch-icon" href="${publicPrefix}/apple-touch-icon.png">
<script>try { document.documentElement.dataset.theme = localStorage.getItem('settings-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') } catch {}</script>
<style>${panelStyles}</style>
</head><body>
<header><div class="header-inner">
  <div class="brand"><span class="brand-mark">${icon('brand')}</span><div><h1>设置</h1><div class="brand-sub" id="brandContext">微信 Bot</div></div></div>
  <div class="header-tools">
    <span class="service-badge" id="serviceBadge" hidden>设置在线</span>
    <button class="icon-button ghost" id="themeToggle" aria-label="切换明暗主题" title="切换明暗主题">${icon('theme')}</button>
    <details class="more-menu" id="pageMore"><summary aria-label="更多操作" title="更多操作">${icon('more')}</summary><div class="menu-popover"><button class="ghost" id="installApp">添加到桌面</button><button class="ghost" id="devicesOpen">登录设备</button><button class="ghost" id="export">${icon('download')}导出当前设置</button><button class="ghost danger" id="browserLogout">退出网页登录</button></div></details>
  </div>
</div></header>
<section class="sign-in card" id="signIn" hidden><div class="card-body"><h2>登录设置</h2><p class="muted" style="margin:10px 0 22px">首次绑定一次，之后直接打开。</p><form id="signInForm"><label class="field"><span>一次性登录 / 绑定码</span><input id="signInCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{8}" maxlength="8" required placeholder="8 位验证码"></label><button class="primary" type="submit">登录并记住此设备</button><p class="hint" style="margin-top:16px">在微信向 bot 发送“设置”获取绑定码。Bot 离线时，可在电脑运行设置服务的 pair 命令获取。</p></form></div></section>
<div class="layout" id="appContent" hidden>
  <aside class="sidebar"><div class="nav-caption">偏好设置</div><nav aria-label="设置分类">
    ${nav('chat','聊天')}${nav('memory','记忆')}${nav('stickers','表情库')}${nav('personas','人格',true)}
    <span class="nav-divider" aria-hidden="true"></span>${nav('help','帮助')}${nav('account','连接',true)}
  </nav></aside>
  <main>
    <div class="context-bar" id="contactContext" hidden>
      <label class="peer-control" id="peerControl">当前聊天<select id="peer" disabled aria-label="选择联系人"><option>加载中…</option></select></label>
      <details class="context-details"><summary>联系人信息</summary><code id="peerIdentity"></code></details>
    </div>
    <section id="chat">
      <div class="page-head"><div><h2>聊天设置</h2><p>调整这个聊天的回复方式。</p></div></div>
      <form id="chatForm" class="card">
        <div class="card-body">
          <div class="setting-row"><div class="row-label"><h3>聊天人格</h3><p class="hint" id="personaHint">选择喜欢的说话方式</p></div><select id="chatPersona" aria-label="聊天人格"></select></div>
          <div class="setting-row"><div class="row-label"><h3>接收回复</h3><p class="hint">关闭后，bot 暂停回复此聊天</p></div><input class="switch" role="switch" type="checkbox" id="chatEnabled" aria-label="回复这个联系人"></div>
        </div>
        <details class="fold" id="replyAdvanced"><summary>更多回复设置</summary><div class="fold-body">
          <div class="grid"><label class="field"><span>每条消息字数</span><input id="chatChars" type="number" min="20" max="4096" placeholder="跟随人格默认值"></label><label class="field"><span>长回答如何分条</span><select id="chatSplit"><option value="">跟随人格</option><option value="paragraph">按段落</option><option value="sentence">按句子</option><option value="none">不主动切分</option></select></label></div>
          <p>只调整发送方式，不限制回答的详细程度。</p><button type="button" class="ghost" id="styleReset">恢复默认分条</button>
        </div></details>
        <div class="form-footer"><span class="hint" id="chatSaveState" role="status">已保存</span><div class="toolbar"><button class="ghost" type="button" id="chatRevert" hidden>撤销修改</button><button class="primary" type="submit" id="chatSave" disabled>保存修改</button></div></div>
      </form>
      <div class="card"><div class="card-body"><h3 style="margin-bottom:13px">对话操作</h3><div class="actions-grid">
        <button data-control="new">新对话<span>保留历史与记忆</span></button><button data-control="compact">压缩上下文<span>整理旧消息为摘要</span></button><button data-control="stop">停止任务<span>取消未完成的回复</span></button>
      </div></div></div>
    </section>
    <section id="memory" hidden>
      <div class="page-head"><div><h2>个人记忆<span class="count" id="memoryCount">0</span></h2><p>记住重要的事，下次聊天接着聊。</p></div><button id="memoryAdd" class="primary">${icon('plus')}新增</button></div>
      <div class="filters"><label class="search-box">${icon('search')}<input id="memorySearch" type="search" placeholder="搜索记忆" aria-label="搜索记忆"></label><select id="memoryType" aria-label="筛选记忆类型"><option value="">全部类型</option><option>个人背景</option><option>个人经历</option><option>目标与方向</option><option>观点与想法</option><option>稳定偏好</option></select></div>
      <div id="memories" class="card" aria-live="polite">加载中…</div>
      <details class="card fold" id="memoryMore"><summary>记忆管理</summary><div class="fold-body"><p>清空只影响当前联系人，删除后不会自动重新收录同一内容。</p><button id="memoryClear" class="danger">清空此联系人的记忆</button><div id="legacyMemory" class="hint"></div></div></details>
    </section>
    <section id="stickers" hidden>
      <div class="page-head"><div><h2>表情库<span class="count" id="stickerCount">0</span></h2><p>点开图片，调整名字和使用场景。</p></div></div>
      <div class="filters"><label class="search-box">${icon('search')}<input id="stickerSearch" type="search" placeholder="搜索表情" aria-label="搜索表情"></label><select id="stickerStatus" aria-label="筛选表情状态"><option value="">全部状态</option><option value="ready">可用</option><option value="pending">待判断</option><option value="ignored">已忽略</option></select></div>
      <div id="images" class="gallery" aria-live="polite">加载中…</div>
      <details class="card fold"><summary>共享表情<span class="count" id="sharedCount">0</span></summary><div class="fold-body"><p>所有聊天均可使用，管理员可移除。</p><div id="shared" class="shared-list"></div></div></details>
    </section>
    <section id="personas" hidden data-admin>
      <div class="page-head"><div><h2>人格</h2><p>选择一种相处方式，也可以自己定义。</p></div><button id="personaAdd" class="primary">${icon('plus')}新建</button></div>
      <div id="personaList" class="card">加载中…</div>
    </section>
    <section id="help" hidden>
      <div class="page-head"><div><h2>使用帮助</h2><p>平时直接聊天，设置在这里调整。</p></div></div>
      <div class="card"><div class="card-body"><h3>常用操作</h3><div class="help-row"><code>设置</code><span>打开本页，管理聊天和记忆</span></div><div class="help-row"><code>新对话</code><span>从新上下文开始，历史与记忆保留</span></div><div class="help-row"><code>停止</code><span>中断当前任务和待发送内容</span></div></div><details class="fold"><summary>全部微信指令</summary><div class="fold-body">${help}</div></details></div>
      <div class="card"><div class="card-body faq"><h3>常见问题</h3>
        ${faq}
      </div></div>
    </section>
    <section id="account" hidden data-admin>
      <div class="page-head"><div><h2>连接状态</h2><p>管理微信登录。</p></div></div>
      <div class="card"><div class="card-body"><div class="status-line"><span class="status-dot" id="statusDot"></span><span id="status">加载中…</span></div><p id="loginMessage" class="hint"></p><div id="qr" class="qr"></div><form id="verifyForm" hidden><label class="field"><span>手机上的验证码</span><input id="verifyCode" inputmode="numeric" pattern="[0-9]{4,8}"></label><button class="primary" type="submit">提交验证码</button></form></div>
      <details class="fold"><summary>管理登录</summary><div class="fold-body"><div class="toolbar"><button id="loginBegin">重新扫码</button><button id="logout" class="danger">退出登录</button></div></div></details></div>
    </section>
    <footer id="colophon">数据保存在本机</footer>
  </main>
</div>
<div id="feedback" role="status" aria-live="polite" hidden></div>
<dialog id="entryDialog" aria-labelledby="entryTitle"><form id="entryForm">
  <div class="dialog-head"><h2 id="entryTitle">编辑</h2><button class="icon-button ghost" type="button" data-close="entryDialog" aria-label="关闭编辑">${icon('close')}</button></div>
  <div class="dialog-body" id="entryFields"></div><p class="dialog-message" data-dialog-message hidden></p>
  <div class="dialog-actions"><button class="ghost danger" id="entryDelete" type="button">删除</button><div class="toolbar"><button class="ghost" id="entryPublish" type="button" hidden>加入共享</button><button type="button" data-close="entryDialog">取消</button><button class="primary" id="entrySave" type="submit">保存</button></div></div>
</form></dialog>
<dialog id="personaDialog" aria-labelledby="personaTitle"><form id="personaEditor">
  <div class="dialog-head"><h2 id="personaTitle">编辑人格</h2><button class="icon-button ghost" type="button" data-close="personaDialog" aria-label="关闭人格编辑">${icon('close')}</button></div>
  <div class="dialog-body"><label class="field"><span>显示名称</span><input id="personaName" required placeholder="给 TA 取个名字"></label><label class="field"><span>一句话介绍</span><input id="personaDescription" placeholder="描述 TA 的特点"></label><label class="field"><span>身份与性格</span><textarea id="personaIdentity" rows="4" required placeholder="TA 是谁，怎样与你相处"></textarea></label><div class="grid"><label class="field"><span>说话方式</span><textarea id="personaStyle" rows="3" placeholder="每行一条"></textarea></label><label class="field"><span>行为规则</span><textarea id="personaRules" rows="3" placeholder="每行一条"></textarea></label></div><label class="check"><input id="personaStickers" type="checkbox">允许使用表情包</label>
    <label class="field" id="personaIdField" style="margin-top:18px"><span>人格 ID</span><input id="personaId" required pattern="[a-z0-9-]{1,32}" maxlength="32" placeholder="例如 my-persona"><small class="muted">小写字母、数字和连字符，用于识别这张卡。</small></label>
    <details class="editor-advanced" id="personaAdvanced"><summary>高级 · 完整 JSON</summary><p class="hint" style="margin-bottom:10px">可编辑示例对话等字段，收起后会同步到表单。</p><textarea id="personaraw" rows="16" spellcheck="false" aria-label="完整人格卡 JSON"></textarea></details>
  </div><p class="dialog-message" data-dialog-message hidden></p>
  <div class="dialog-actions"><span class="hint">修改会影响使用此人格的聊天</span><div class="toolbar"><button id="personaCancel" type="button" data-close="personaDialog">取消</button><button class="primary" type="submit">保存人格</button></div></div>
</form></dialog>
<dialog id="installDialog" aria-labelledby="installTitle"><div class="dialog-head"><h2 id="installTitle">固定入口</h2><button class="icon-button ghost" data-close="installDialog" aria-label="关闭">${icon('close')}</button></div><div class="dialog-body"><p>可以收藏本页，或添加到手机桌面。</p><p class="hint" style="margin:12px 0 20px">iPhone：用 Safari 打开，点“分享 → 添加到主屏幕”。Android：在浏览器菜单选择“安装应用”或“添加到主屏幕”。</p><label class="field"><span>固定地址</span><input id="fixedAddress" readonly></label><button id="copyAddress">复制地址</button><div style="margin-top:24px"><h3>换一个浏览器或设备？</h3><p class="hint">生成一次性绑定码，在新设备登录。已经登录的设备不受影响。</p><button id="handoffCreate" style="margin-top:12px">生成绑定码</button><p id="handoffCode" class="hint" style="margin-top:12px"></p></div></div></dialog>
<dialog id="devicesDialog" aria-labelledby="devicesTitle"><div class="dialog-head"><h2 id="devicesTitle">已登录设备</h2><button class="icon-button ghost" data-close="devicesDialog" aria-label="关闭">${icon('close')}</button></div><div class="dialog-body" id="deviceList"></div><p class="dialog-message" data-dialog-message hidden></p></dialog>
<script>
const P = ${JSON.stringify(publicPrefix)}
${panelClient}
${panelAuthClient}
void run(null,init)
</script></body></html>`
}
