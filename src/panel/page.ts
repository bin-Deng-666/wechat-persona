/** 页面本身：足够小，不需要构建。 */
export function renderPage(publicPrefix: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>微信人格通道</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 -apple-system, "PingFang SC", sans-serif; margin: 0; padding: 32px; max-width: 760px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .muted { opacity: .65; }
  .card { border: 1px solid rgba(127,127,127,.3); border-radius: 10px; padding: 20px; margin: 16px 0; }
  .qr { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
  .qr svg { width: 220px; height: 220px; background: #fff; padding: 8px; border-radius: 8px; }
  button { font: inherit; padding: 6px 14px; border-radius: 8px; border: 1px solid rgba(127,127,127,.4); background: transparent; cursor: pointer; }
  button.primary { background: #07c160; border-color: #07c160; color: #fff; }
  input { font: inherit; padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(127,127,127,.4); background: transparent; width: 140px; }
  code { background: rgba(127,127,127,.15); padding: 1px 5px; border-radius: 4px; }
  ul { padding-left: 18px; margin: 8px 0; }
  .err { color: #d33; }
</style>
</head>
<body>
  <h1>微信人格通道</h1>
  <p class="muted">扫描二维码后，这个微信号会成为你微信通讯录里的一个 Bot 联系人。</p>

  <div class="card">
    <div id="status" class="muted">加载中…</div>
    <div class="qr" id="qrbox" hidden>
      <div id="qr"></div>
      <div>
        <p id="qrmsg"></p>
        <div id="verifybox" hidden>
          <input id="code" inputmode="numeric" placeholder="手机上的数字">
          <button class="primary" id="verify">提交</button>
        </div>
        <button id="begin">重新取码</button>
        <button id="logout">退出登录</button>
      </div>
    </div>
    <p id="detail" class="err"></p>
  </div>

  <div class="card">
    <h2 style="font-size:15px;margin:0 0 8px">人格卡</h2>
    <div id="personas" class="muted">加载中…</div>
    <div id="editor" hidden style="margin-top:12px">
      <textarea id="personaraw" rows="16" spellcheck="false"
        style="width:100%;box-sizing:border-box;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:10px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit"></textarea>
      <div style="display:flex;gap:10px;align-items:center;margin-top:8px">
        <button class="primary" id="savepersona">保存</button>
        <button id="cancelpersona">取消</button>
        <span id="personamsg" class="muted"></span>
      </div>
    </div>
  </div>

  <div class="card">
    <h2 style="font-size:15px;margin:0 0 4px">聊天设置</h2>
    <p class="muted" style="margin:0 0 10px">和你说过话的微信 id 会出现在这里；改完即时生效。</p>
    <div id="chats" class="muted">加载中…</div>
  </div>

<script>
const P = '${publicPrefix}'
const KEY = new URLSearchParams(location.search).get('key') || ''
const q = path => P + path + (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(KEY)
const $ = id => document.getElementById(id)
let timer

async function post(path, body) {
  const res = await fetch(q(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return await res.json()
}

function render(view) {
  $('qrmsg').textContent = view.message || ''
  $('detail').textContent = view.detail || ''
  $('verifybox').hidden = view.phase !== 'verify'
  if (view.qr) {
    $('qrbox').hidden = false
    $('qr').innerHTML = view.qr.svg
  } else {
    $('qrbox').hidden = true
  }
}

async function refresh() {
  const res = await fetch(q('/status'))
  const status = await res.json()
  render(status.login)
  $('status').innerHTML = status.connected
    ? '已连接' + (status.userId ? '：<code>' + status.userId + '</code>' : '') + '<br><span class="muted">人格卡目录：<code>' + status.dataDir + '</code></span>'
    : '未连接'
  if (status.login.phase === 'waiting' || status.login.phase === 'scanned') {
    clearTimeout(timer)
    timer = setTimeout(poll, 1500)
  }
}

async function poll() {
  const view = await post('/poll')
  render(view)
  if (view.phase === 'waiting' || view.phase === 'scanned') timer = setTimeout(poll, 1500)
  if (view.phase === 'connected') refresh()
}

$('begin').onclick = async () => { render(await post('/begin')) ; poll() }
$('logout').onclick = async () => { render(await post('/logout')); refresh() }
$('verify').onclick = async () => {
  render(await post('/verify-code', { code: $('code').value }))
  poll()
}
$('code').addEventListener('keydown', e => { if (e.key === 'Enter') $('verify').click() })
$('savepersona').addEventListener('click', savePersona)
$('cancelpersona').addEventListener('click', () => { $('editor').hidden = true })

async function loadPersonas() {
  const list = await (await fetch(q('/personas'))).json()
  if (list.length === 0) {
    $('personas').innerHTML = '还没有人格卡。点下面的「新建」写一张，或在数据目录下建 <code>personas/&lt;id&gt;/persona.json</code>。'
    return
  }
  $('personas').innerHTML = '<ul style="padding-left:18px">' + list.map(p =>
    '<li style="margin:4px 0"><b>' + p.name + '</b> <code>' + p.id + '</code>' +
    (p.description ? ' — ' + p.description : '') +
    ' <button data-edit="' + p.id + '">编辑</button>' +
    (p.warnings && p.warnings.length ? ' <span class="err">（' + p.warnings.length + ' 条告警）</span>' : '') +
    '</li>'
  ).join('') + '</ul>'
  for (const button of document.querySelectorAll('#personas button[data-edit]')) {
    button.addEventListener('click', () => openPersona(button.getAttribute('data-edit')))
  }
}

async function openPersona(id) {
  const result = await (await fetch(q('/persona?id=' + encodeURIComponent(id)))).json()
  $('editor').hidden = false
  $('personaraw').value = result.ok ? result.raw : ''
  $('personamsg').textContent = result.ok ? '正在编辑 ' + id : (result.error || '读取失败')
  $('editor').setAttribute('data-id', id)
}

async function savePersona() {
  const id = $('editor').getAttribute('data-id')
  if (!id) { $('personamsg').textContent = '先选一张卡'; return }
  const res = await post('/persona/save', { id, raw: $('personaraw').value })
  if (res.ok) {
    $('personamsg').textContent = res.warnings && res.warnings.length ? '已保存（' + res.warnings.join('；') + '）' : '已保存'
    loadPersonas()
  } else {
    $('personamsg').textContent = '没保存：' + (res.issues || []).join('；')
  }
}

async function loadChats() {
  const personas = await (await fetch(q('/personas'))).json()
  const chats = await (await fetch(q('/chats'))).json()
  if (chats.length === 0) { $('chats').textContent = '还没有聊天记录：先在微信里发一条消息。'; return }
  $('chats').innerHTML = chats.map(c => {
    const options = ['<option value="">（跟随默认）</option>'].concat(
      personas.map(p => '<option value="' + p.id + '"' + (p.id === c.personaId ? ' selected' : '') + '>' + p.name + '</option>')
    ).join('')
    return '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 0;border-top:1px solid rgba(127,127,127,.15)">' +
      '<code>' + c.peerId + '</code>' +
      '<select data-peer="' + c.peerId + '" data-field="personaId">' + options + '</select>' +
      '<label><input type="checkbox" data-peer="' + c.peerId + '" data-field="enabled"' + (c.enabled ? ' checked' : '') + '> 回复</label>' +
      '</div>'
  }).join('')
  for (const el of document.querySelectorAll('#chats select, #chats input')) {
    el.addEventListener('change', async () => {
      const peerId = el.getAttribute('data-peer')
      const field = el.getAttribute('data-field')
      const value = el.type === 'checkbox' ? el.checked : el.value
      await post('/chat', { peerId, [field]: value })
      loadChats()
    })
  }
}

// 顶层不能用 await（这是普通 <script>，不是模块），统一放进 init。
async function init() {
  await loadPersonas()
  await loadChats()
  await refresh()
}
void init()
</script>
</body>
</html>`
}
