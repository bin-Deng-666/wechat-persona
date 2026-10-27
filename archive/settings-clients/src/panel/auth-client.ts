/** 固定入口的网页登录、设备管理和桌面安装交互。 */
export const panelAuthClient = String.raw`
let onlineTimer
function updateOnline(value) {
  botOnline = !!value
  $('serviceBadge').hidden = false
  $('serviceBadge').textContent = botOnline ? 'Bot 在线' : 'Bot 离线 · 设置可用'
  $('serviceBadge').classList.toggle('online',botOnline)
  document.querySelectorAll('[data-control]').forEach(button => { button.disabled = !currentPeer || !botOnline })
}
function showLogin() {
  clearInterval(onlineTimer)
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close())
  $('appContent').hidden = true; $('signIn').hidden = false; $('pageMore').hidden = true; $('serviceBadge').hidden = true
}
async function bootstrapLogin() {
  const fragment = new URLSearchParams(location.hash.slice(1)), token = fragment.get('login'), view = fragment.get('view')
  if (token) {
    history.replaceState(null,'',location.pathname + location.search + (view === 'help' ? '#help' : ''))
    const response = await fetch(q('/auth/exchange'),{method:'POST',headers:{'Content-Type':'application/json','X-Settings-Request':'1'},body:JSON.stringify({token})})
    if (!response.ok) {
      const existing = await fetch(q('/access'))
      if (!existing.ok) { showLogin(); const data = await response.json(); feedback(data.error || '登录未完成',true); return null }
    }
  }
  const response = await fetch(q('/access'))
  if (response.status === 401) { showLogin(); return null }
  if (!response.ok) throw new Error('设置服务暂时连接不上。')
  const access = await response.json()
  $('fixedAddress').value = access.address || location.origin + P + '/panel'
  clearInterval(onlineTimer)
  onlineTimer = setInterval(async () => {
    if (document.visibilityState !== 'visible' || $('appContent').hidden) return
    try { const current = await api('/access'); updateOnline(current.botOnline) } catch {}
  },20000)
  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register(P + '/service-worker.js',{scope:P + '/'}).catch(() => {})
  return access
}
$('signInForm').onsubmit = event => { event.preventDefault(); void run(event.submitter,async () => {
  await api('/auth/exchange',{code:$('signInCode').value.trim()}); $('signInCode').value = ''; await init()
}) }
action('browserLogout',async () => { await api('/auth/logout',{}); showLogin(); feedback('已退出此设备。') })
action('installApp',async () => { $('pageMore').open = false; $('installDialog').showModal() })
action('copyAddress',async () => {
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText($('fixedAddress').value)
  else { $('fixedAddress').select(); if (!document.execCommand('copy')) throw new Error('请长按地址手动复制') }
  feedback('固定地址已复制。')
})
action('handoffCreate',async () => {
  const pair = await api('/auth/link',{})
  $('handoffCode').textContent = '绑定码：' + pair.code + '（10 分钟内有效，只能使用一次）'
})
action('devicesOpen',async () => {
  $('pageMore').open = false
  const data = await api('/auth/devices'); $('deviceList').replaceChildren()
  for (const device of data.devices) {
    const row = document.createElement('div'); row.className = 'device-item'
    const copy = document.createElement('div'); copy.innerHTML = '<h3>' + esc(device.label) + (device.current ? ' <span class="badge">当前设备</span>' : '') + '</h3><p class="hint">最近使用：' + esc(new Date(device.lastSeenAt).toLocaleString('zh-CN')) + '</p>'
    const revoke = document.createElement('button'); revoke.className = 'ghost danger'; revoke.textContent = device.current ? '退出' : '撤销'
    revoke.onclick = () => void run(revoke,async () => {
      if (!confirm('撤销这个设备的登录？')) return
      await api('/auth/revoke',{id:device.id}); row.remove()
      if (device.current) { $('devicesDialog').close(); showLogin() }
    })
    row.append(copy,revoke); $('deviceList').append(row)
  }
  $('devicesDialog').querySelector('[data-dialog-message]').hidden = true; $('devicesDialog').showModal()
})
`
