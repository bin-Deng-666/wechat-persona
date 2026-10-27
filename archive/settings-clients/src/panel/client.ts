/** 浏览器交互源码，作为普通 script 内联到设置页。 */
export const panelClient = String.raw`
const $ = id => document.getElementById(id)
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]))
const q = path => P + path
const types = ['个人背景','个人经历','目标与方向','观点与想法','稳定偏好']
const certainties = ['明确','当前倾向','探索中']
const statusLabels = { ready:'可用',pending:'待判断',ignored:'已忽略' }
const editIcon = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6zM14 5l5 5"/></svg>'
let admin = false, botOnline = false, currentPeer = '', peers = [], personas = [], selection = 0, renderedSection = 'chat'
let memoryData = { memories:[],legacy:[] }, stickerData = { images:[],shared:[] }
let entry = null, entryBaseline = '', cardDraft = null, personaBaseline = '', advanced = false
let chatBaseline = '', chatSaving = false, feedbackTimer, pollTimer

function feedback(text, error = false) {
  clearTimeout(feedbackTimer)
  const dialog = document.querySelector('dialog[open]')
  if (error && dialog && dialog.querySelector('[data-dialog-message]')) {
    const message = dialog.querySelector('[data-dialog-message]')
    message.textContent = text; message.hidden = false; message.setAttribute('role','alert')
    message.scrollIntoView({block:'nearest',behavior:'smooth'})
    return
  }
  $('feedback').hidden = false; $('feedback').textContent = text; $('feedback').dataset.error = String(error)
  if (!error) feedbackTimer = setTimeout(() => { $('feedback').hidden = true },3500)
}
function errorOf(data) { return data.error || data.message || (data.issues || []).join('；') || '操作未完成' }
async function api(path, body) {
  const response = await fetch(q(path), body === undefined ? {} : { method:'POST',headers:{'Content-Type':'application/json','X-Settings-Request':'1'},body:JSON.stringify(body) })
  if (response.status === 401) { showLogin(); throw new Error('请先登录设置页。') }
  const data = await response.json().catch(() => { throw new Error('暂时连接不上，请稍后重试。') })
  if (!response.ok || data.ok === false) throw new Error(errorOf(data))
  return data
}
async function run(button, task) {
  if (button) button.disabled = true
  try { await task() } catch (error) { feedback(error.message,true) }
  finally { if (button && button.isConnected) button.disabled = false; updateChatState() }
}
const action = (id, task) => $(id).addEventListener('click', event => void run(event.currentTarget,task))
function own(path, peer = currentPeer) { return path + '?peerId=' + encodeURIComponent(peer) }
function option(value, label, selected) { return '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + '>' + esc(label) + '</option>' }
function field(name,label,value,multiline = false,required = false) {
  return '<label class="field"><span>' + label + '</span>' + (multiline
    ? '<textarea rows="4" data-f="' + name + '"' + (required ? ' required' : '') + '>' + esc(value) + '</textarea>'
    : '<input data-f="' + name + '" value="' + esc(value) + '"' + (required ? ' required' : '') + '>') + '</label>'
}
function selectField(name,label,values,selected) {
  return '<label class="field"><span>' + label + '</span><select data-f="' + name + '">' + values.map(value => option(value,value,selected)).join('') + '</select></label>'
}
function empty(container,title,note) {
  container.innerHTML = '<div class="empty"><span class="empty-icon" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 10h8M8 14h5"/></svg></span><strong>' + esc(title) + '</strong><span>' + esc(note) + '</span></div>'
}
function chatPayload() {
  return { personaId:$('chatPersona').value,enabled:$('chatEnabled').checked,maxChars:$('chatChars').value === '' ? null : Number($('chatChars').value),split:$('chatSplit').value || null }
}
function chatDirty() { return !!currentPeer && !!chatBaseline && JSON.stringify(chatPayload()) !== chatBaseline }
function updateChatState() {
  const dirty = chatDirty()
  $('chatSave').disabled = !currentPeer || !dirty || chatSaving
  $('chatRevert').hidden = !dirty
  $('chatSaveState').textContent = chatSaving ? '保存中…' : dirty ? '有未保存的修改' : '已保存'
}
function leaveChat() { return !chatDirty() || confirm('聊天设置还没保存，放弃这些修改？') }
function route() {
  const allowed = ['chat','memory','stickers','help'].concat(admin ? ['personas','account'] : [])
  const id = allowed.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'chat'
  if (id !== renderedSection && chatDirty()) {
    if (!leaveChat()) { history.replaceState(null,'','#' + renderedSection); return }
    renderChat()
  }
  renderedSection = id; $('feedback').hidden = true
  document.querySelectorAll('main > section').forEach(section => { section.hidden = section.id !== id })
  document.querySelectorAll('nav a').forEach(link => {
    if (link.hash === '#' + id) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current')
  })
  const active = document.querySelector('nav a[aria-current="page"]')
  if (innerWidth <= 760 && active) active.scrollIntoView({block:'nearest',inline:'nearest'})
  window.scrollTo({top:0,behavior:'instant'})
}
window.addEventListener('hashchange',route)
window.addEventListener('beforeunload',event => {
  if (chatDirty() || dialogDirty('entryDialog') || dialogDirty('personaDialog')) { event.preventDefault(); event.returnValue = '' }
})
action('themeToggle',async () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = next
  try { localStorage.setItem('settings-theme',next) } catch {}
})
document.addEventListener('click',event => { if (!$('pageMore').contains(event.target)) $('pageMore').open = false })
function renderChat() {
  const chat = peers.find(peer => peer.peerId === currentPeer)
  $('chatForm').querySelectorAll('input,select,button').forEach(el => { el.disabled = !chat })
  $('chatPersona').innerHTML = option('','跟随默认人格',chat?.personaId || '') + personas.map(p => option(p.id,p.name,chat?.personaId)).join('')
  const persona = personas.find(p => p.id === chat?.personaId)
  $('personaHint').textContent = '决定 bot 的语气与性格'
  $('brandContext').textContent = persona ? persona.name + ' · 微信 Bot' : '微信 Bot'
  $('chatEnabled').checked = chat?.enabled ?? true; $('chatChars').value = chat?.maxChars ?? ''; $('chatSplit').value = chat?.split ?? ''
  document.querySelectorAll('[data-control]').forEach(button => { button.disabled = !chat || !botOnline })
  $('memoryAdd').disabled = $('memoryClear').disabled = !chat
  $('peerIdentity').textContent = currentPeer
  chatBaseline = JSON.stringify(chatPayload()); updateChatState()
}
$('chatForm').addEventListener('input',updateChatState)
$('chatForm').addEventListener('change',updateChatState)
action('chatRevert',async () => renderChat())
action('styleReset',async () => { $('chatChars').value = ''; $('chatSplit').value = ''; updateChatState() })
async function saveChat(patch) {
  const peer = currentPeer
  if (!peer) return
  chatSaving = true; $('chatForm').querySelectorAll('input,select,button').forEach(el => { el.disabled = true }); updateChatState()
  try {
    const saved = await api('/chat',{peerId:peer,...patch})
    peers = peers.map(value => value.peerId === peer ? saved : value)
    if (peer === currentPeer) { renderChat(); renderPersonas() }
    feedback('聊天设置已保存。')
  } finally {
    chatSaving = false; $('chatForm').querySelectorAll('input,select,button').forEach(el => { el.disabled = !currentPeer }); updateChatState()
  }
}
$('chatForm').onsubmit = event => { event.preventDefault(); const payload = chatPayload(); void run(event.submitter,async () => await saveChat(payload)) }
for (const button of document.querySelectorAll('[data-control]')) button.onclick = () => void run(button,async () => {
  const act = button.dataset.control
  if (act === 'new' && !confirm('开启新对话？当前任务会停止，历史和记忆保留。')) return
  const result = await api('/chat/control',{peerId:currentPeer,action:act}); feedback(result.message)
})
async function changePeer() {
  const version = ++selection, peer = currentPeer
  $('feedback').hidden = true; renderChat(); renderPersonas()
  memoryData = {memories:[],legacy:[]}; stickerData = {images:[],shared:[]}
  $('memorySearch').value = $('stickerSearch').value = $('memoryType').value = $('stickerStatus').value = ''
  if (!peer) { renderMemories(); renderStickers(); return }
  $('memories').textContent = $('images').textContent = '加载中…'
  await Promise.all([loadMemory(peer,version),loadStickers(peer,version)])
}
async function loadMemory(peer,version) {
  const data = await api(own('/memory',peer)); if (version !== selection) return
  memoryData = data; renderMemories()
}
function renderMemories() {
  $('memoryCount').textContent = String(memoryData.memories.length)
  $('legacyMemory').textContent = memoryData.legacy.length ? '旧版未核实资料：' + memoryData.legacy.join('；') : ''
  const query = $('memorySearch').value.trim().toLocaleLowerCase(), type = $('memoryType').value
  const matches = memoryData.memories.filter(memory => (!type || memory.type === type) && [memory.title,memory.content,memory.scope,...memory.tags].join(' ').toLocaleLowerCase().includes(query))
  $('memories').replaceChildren()
  if (!matches.length) { empty($('memories'),memoryData.memories.length ? '没有匹配的记忆' : '还没有记忆',memoryData.memories.length ? '换个关键词或类型试试。' : '重要的偏好和经历，可以记在这里。'); return }
  for (const memory of matches) {
    const row = document.createElement('div'); row.className = 'memory-item'
    const body = document.createElement('div'); body.className = 'item-body'
    body.innerHTML = '<div class="item-title"><h3>' + esc(memory.title) + '</h3><span class="badge">' + esc(memory.type) + '</span></div><p>' + esc(memory.content) + '</p><div class="item-meta">' + esc(memory.scope || memory.certainty) + (memory.sources.length ? ' · 有原话来源' : ' · 人工输入') + '</div>'
    const edit = document.createElement('button'); edit.className = 'icon-button ghost'; edit.innerHTML = editIcon; edit.setAttribute('aria-label','编辑记忆：' + memory.title); edit.title = '编辑记忆'; edit.onclick = () => openMemory(memory)
    row.append(body,edit); $('memories').append(row)
  }
}
$('memorySearch').addEventListener('input',renderMemories); $('memoryType').addEventListener('change',renderMemories)
action('memoryAdd',async () => { if (currentPeer) openMemory(null) })
action('memoryClear',async () => {
  const peer = currentPeer
  if (!peer || !confirm('清空这个联系人的全部记忆？此操作无法撤销。')) return
  await api(own('/memory/clear',peer),{}); feedback('记忆已清空。'); if (peer === currentPeer) await loadMemory(peer,selection)
})
function showEntry(title) {
  const dialog = $('entryDialog')
  $('entryTitle').textContent = title; dialog.querySelector('[data-dialog-message]').hidden = true
  entryBaseline = JSON.stringify(readEntryFields())
  dialog.showModal(); dialog.scrollTop = 0
  const first = $('entryFields').querySelector('input,select,textarea'); if (first) first.focus({preventScroll:true})
}
function readEntryFields() { return Object.fromEntries([...$('entryFields').querySelectorAll('[data-f]')].map(field => [field.dataset.f,field.value])) }
function openMemory(memory) {
  entry = {kind:'memory',peer:currentPeer,record:memory}
  $('entryFields').innerHTML = field('title','标题',memory?.title,false,true) + field('content','记忆内容',memory?.content,true,true)
    + '<details class="editor-advanced"><summary>类型与适用范围</summary><div class="grid">' + selectField('type','记忆类型',types,memory?.type || '稳定偏好') + selectField('certainty','确定性',certainties,memory?.certainty || '明确') + '</div>' + field('scope','适用范围',memory?.scope) + field('tags','标签（顿号分隔）',memory?.tags?.join('、')) + '</details>'
    + '<details class="editor-advanced sources"><summary>原话来源' + (memory ? ' · 版本 ' + memory.version : '') + '</summary>' + (memory?.sources?.length ? memory.sources.map(source => '<blockquote>' + esc(source.quote) + '<small>' + esc(source.timestamp) + ' · ' + esc(source.entryId) + '</small></blockquote>').join('') : '<p>人工输入，没有原话来源。</p>') + '</details>'
  $('entryDelete').hidden = !memory; $('entryDelete').textContent = '删除记忆'; $('entryPublish').hidden = true
  showEntry(memory ? '编辑记忆' : '新增记忆')
}
async function loadStickers(peer,version) {
  const data = await api(own('/stickers',peer)); if (version !== selection) return
  stickerData = data; renderStickers()
}
function renderStickers() {
  const query = $('stickerSearch').value.trim().toLocaleLowerCase(), status = $('stickerStatus').value
  const matches = stickerData.images.filter(image => (!status || status === image.status) && [image.name,image.description,image.scenes].join(' ').toLocaleLowerCase().includes(query))
  $('stickerCount').textContent = String(stickerData.images.length); $('sharedCount').textContent = String(stickerData.shared.length)
  $('images').replaceChildren()
  if (!matches.length) empty($('images'),stickerData.images.length ? '没有匹配的表情' : '还没有表情',stickerData.images.length ? '换个关键词或状态试试。' : '在微信发张图片给 bot，它会出现在这里。')
  for (const image of matches) {
    const button = document.createElement('button'); button.className = 'sticker-card'; button.setAttribute('aria-label','编辑表情：' + (image.name || '未命名图片'))
    const src = q(own('/sticker/image') + '&id=' + encodeURIComponent(image.id))
    button.innerHTML = '<span class="image-well"><img class="preview" loading="lazy" alt="' + esc(image.name || '表情预览') + '" src="' + esc(src) + '"></span><span class="sticker-meta"><strong>' + esc(image.name || '未命名图片') + '</strong><span class="badge ' + image.status + '">' + statusLabels[image.status] + '</span></span>'
    button.onclick = () => openSticker(image); $('images').append(button)
  }
  $('shared').replaceChildren()
  if (!stickerData.shared.length) { $('shared').textContent = '暂无共享表情'; return }
  for (const shared of stickerData.shared) {
    const chip = document.createElement('div'); chip.className = 'shared-chip'
    const name = document.createElement('span'); name.textContent = shared.name; chip.append(name)
    if (admin) {
      const remove = document.createElement('button'); remove.className = 'ghost danger'; remove.textContent = '×'; remove.setAttribute('aria-label','删除共享表情：' + shared.name)
      remove.onclick = () => void run(remove,async () => { const peer = currentPeer; if (!confirm('删除共享表情“' + shared.name + '”？所有聊天将无法再使用。')) return; await api('/sticker/unpublish',{name:shared.name}); feedback('共享表情已删除。'); if (peer === currentPeer) await loadStickers(peer,selection) })
      chip.append(remove)
    }
    $('shared').append(chip)
  }
}
$('stickerSearch').addEventListener('input',renderStickers); $('stickerStatus').addEventListener('change',renderStickers)
function openSticker(image) {
  entry = {kind:'sticker',peer:currentPeer,record:image}
  const src = q(own('/sticker/image') + '&id=' + encodeURIComponent(image.id))
  $('entryFields').innerHTML = '<img class="dialog-image" alt="表情原图" src="' + esc(src) + '">' + field('name','表情名称',image.name) + '<label class="field"><span>使用状态</span><select data-f="status">' + Object.entries(statusLabels).map(([value,label]) => option(value,label,image.status)).join('') + '</select></label>' + field('description','画面描述',image.description) + field('scenes','适用场景',image.scenes)
  $('entryDelete').hidden = false; $('entryDelete').textContent = '移出目录'; $('entryPublish').hidden = !admin
  showEntry('编辑表情')
}
$('entryForm').onsubmit = event => { event.preventDefault(); void run(event.submitter,async () => {
  const draft = entry, values = readEntryFields()
  if (draft.kind === 'memory') {
    const memory = draft.record
    await api('/memory/save',{peerId:draft.peer,...values,tags:values.tags.split(/[、,，]/).map(t => t.trim()).filter(Boolean),...(memory ? {id:memory.id,version:memory.version} : {})})
    $('entryDialog').close(); feedback('记忆已保存。'); if (draft.peer === currentPeer) await loadMemory(draft.peer,selection)
  } else {
    await api('/sticker/save',{peerId:draft.peer,id:draft.record.id,...values})
    $('entryDialog').close(); feedback('表情已保存。'); if (draft.peer === currentPeer) await loadStickers(draft.peer,selection)
  }
}) }
action('entryDelete',async () => {
  const draft = entry
  if (draft.kind === 'memory') {
    if (!confirm('删除“' + draft.record.title + '”？')) return
    await api('/memory/delete',{peerId:draft.peer,id:draft.record.id,version:draft.record.version})
    $('entryDialog').close(); feedback('记忆已删除。'); if (draft.peer === currentPeer) await loadMemory(draft.peer,selection)
  } else {
    if (!confirm('从这个联系人的表情目录移出这张图片？')) return
    await api('/sticker/forget',{peerId:draft.peer,id:draft.record.id})
    $('entryDialog').close(); feedback('已移出目录。'); if (draft.peer === currentPeer) await loadStickers(draft.peer,selection)
  }
})
action('entryPublish',async () => {
  const draft = entry, values = readEntryFields()
  if (!confirm('共享后所有联系人都可以使用，继续？')) return
  await api('/sticker/publish',{peerId:draft.peer,id:draft.record.id,name:values.name})
  $('entryDialog').close(); feedback('已加入共享。'); if (draft.peer === currentPeer) await loadStickers(draft.peer,selection)
})
function renderPersonas() {
  $('personaList').replaceChildren()
  if (!personas.length) { empty($('personaList'),'还没有人格','新建一张人格卡，定义喜欢的说话方式。'); return }
  const current = peers.find(peer => peer.peerId === currentPeer)?.personaId
  for (const persona of personas) {
    const row = document.createElement('div'); row.className = 'persona-item'
    row.innerHTML = '<div class="avatar" aria-hidden="true">' + esc([...persona.name][0] || '人') + '</div><div class="persona-copy"><h3>' + esc(persona.name) + (persona.id === current ? ' <span class="badge">当前使用</span>' : '') + '</h3><p>' + esc(persona.description) + '</p></div>'
    const buttons = document.createElement('div'); buttons.className = 'toolbar'
    const edit = document.createElement('button'); edit.className = 'ghost'; edit.textContent = '编辑'
    edit.onclick = () => void run(edit,async () => { const result = await api('/persona?id=' + encodeURIComponent(persona.id)); openPersona(JSON.parse(result.raw),false) })
    buttons.append(edit)
    if (currentPeer && persona.id !== current) {
      const use = document.createElement('button'); use.textContent = '使用'
      use.onclick = () => void run(use,async () => { if (leaveChat()) await saveChat({personaId:persona.id}) }); buttons.append(use)
    }
    row.append(buttons)
    if (persona.warnings.length) { const warning = document.createElement('span'); warning.className = 'hint'; warning.textContent = '有配置提示'; warning.title = persona.warnings.join('；'); row.querySelector('.persona-copy').append(warning) }
    $('personaList').append(row)
  }
}
function fillPersona(card) {
  $('personaId').value = card.id; $('personaName').value = card.name || ''; $('personaDescription').value = card.description || ''; $('personaIdentity').value = card.prompt.identity
  $('personaStyle').value = (card.prompt.style || []).join('\n'); $('personaRules').value = (card.prompt.rules || []).join('\n'); $('personaStickers').checked = card.media?.sendStickers ?? true
}
function openPersona(card,fresh) {
  cardDraft = card; advanced = false
  $('personaId').readOnly = !fresh; $('personaIdField').hidden = !fresh; fillPersona(card)
  $('personaraw').value = JSON.stringify(card,null,2); $('personaAdvanced').open = false
  $('personaDialog').querySelector('[data-dialog-message]').hidden = true; $('personaTitle').textContent = fresh ? '新建人格' : '编辑人格'
  personaBaseline = JSON.stringify(formCard())
  $('personaDialog').showModal(); $('personaDialog').scrollTop = 0; $('personaName').focus({preventScroll:true})
}
function formCard() {
  const lines = id => $(id).value.split('\n').map(line => line.trim()).filter(Boolean)
  return {...cardDraft,id:$('personaId').value.trim(),name:$('personaName').value.trim(),description:$('personaDescription').value,prompt:{...cardDraft.prompt,identity:$('personaIdentity').value,style:lines('personaStyle'),rules:lines('personaRules')},media:{...cardDraft.media,sendStickers:$('personaStickers').checked}}
}
$('personaAdvanced').addEventListener('toggle',event => {
  if (!cardDraft) return
  if (event.target.open) {
    if (!advanced) $('personaraw').value = JSON.stringify(formCard(),null,2)
    advanced = true
  } else if (advanced) {
    try {
      const card = JSON.parse($('personaraw').value)
      if (!card.prompt || typeof card.prompt.identity !== 'string') throw new Error('身份设定不能为空')
      card.id = $('personaId').value.trim(); cardDraft = card; fillPersona(card); advanced = false
    } catch (error) { feedback('JSON 未能应用：' + error.message,true); event.target.open = true }
  }
})
$('personaEditor').onsubmit = event => { event.preventDefault(); void run(event.submitter,async () => {
  const raw = $('personaAdvanced').open ? $('personaraw').value : JSON.stringify(formCard())
  const result = await api('/persona/save',{id:$('personaId').value.trim(),raw})
  $('personaDialog').close(); feedback('人格已保存。' + (result.warnings || []).join('；'))
  personas = await api('/personas'); renderPersonas(); if (!chatDirty()) renderChat()
}) }
action('personaAdd',async () => openPersona({id:'',name:'',description:'',prompt:{identity:'你是{{name}}。',style:[],rules:[]},reply:{maxChars:160,split:'paragraph'},examples:[],media:{sendStickers:true}},true))
function dialogDirty(id) {
  if (!$(id).open || !['entryDialog','personaDialog'].includes(id)) return false
  if (id === 'entryDialog') return JSON.stringify(readEntryFields()) !== entryBaseline
  try { return JSON.stringify($('personaAdvanced').open ? JSON.parse($('personaraw').value) : formCard()) !== personaBaseline } catch { return true }
}
function closeDialog(id) { if (!dialogDirty(id) || confirm('还有未保存的修改，放弃编辑？')) $(id).close() }
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => closeDialog(button.dataset.close)
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('cancel',event => { event.preventDefault(); closeDialog(dialog.id) })
function loginView(view) {
  $('loginMessage').textContent = (view.message || '') + (view.detail ? ' · ' + view.detail : '')
  $('qr').innerHTML = view.qr?.svg || ''; $('verifyForm').hidden = view.phase !== 'verify'
  clearTimeout(pollTimer)
  if (view.phase === 'waiting' || view.phase === 'scanned') pollTimer = setTimeout(() => void run(null,poll),1500)
}
async function poll() { const view = await api('/poll',{}); loginView(view); if (view.phase === 'connected') await refreshStatus() }
async function refreshStatus() {
  const status = await api('/status'); $('status').textContent = status.botOnline === false ? 'Bot 离线 · 设置服务在线' : status.connected ? '微信已连接' : '微信未连接'
  updateOnline(status.botOnline ?? status.connected)
  $('statusDot').classList.toggle('connected',status.connected); loginView(status.login)
}
action('loginBegin',async () => loginView(await api('/begin',{})))
action('logout',async () => { if (!confirm('退出微信登录？bot 将停止收发消息。')) return; loginView(await api('/logout',{})); await refreshStatus() })
$('verifyForm').onsubmit = event => { event.preventDefault(); void run(event.submitter,async () => loginView(await api('/verify-code',{code:$('verifyCode').value}))) }
action('export',async () => {
  $('pageMore').open = false
  const peer = currentPeer, chat = peers.find(item => item.peerId === peer)
  const data = {exportedAt:new Date().toISOString(),chat,...(peer ? {memory:await api(own('/memory',peer)),stickers:await api(own('/stickers',peer))} : {})}
  const blob = new Blob([JSON.stringify(data,null,2)],{type:'application/json'}), url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = 'wechat-settings.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000); feedback('设置已导出。')
})
async function init() {
  const access = await bootstrapLogin(); if (!access) return
  admin = access.admin; updateOnline(access.botOnline)
  $('signIn').hidden = true; $('appContent').hidden = false; $('pageMore').hidden = false
  document.querySelectorAll('nav [data-admin]').forEach(el => { el.hidden = !admin })
  route()
  ;[peers,personas] = await Promise.all([api('/chats'),api('/personas')])
  const wanted = new URLSearchParams(location.search).get('peer')
  currentPeer = peers.some(peer => peer.peerId === wanted) ? wanted : peers[0]?.peerId || ''
  $('peer').innerHTML = peers.length ? peers.map((peer,index) => option(peer.peerId,'联系人 ' + (index + 1) + ' · ' + (peer.peerId.length > 20 ? peer.peerId.slice(0,8) + '…' + peer.peerId.slice(-8) : peer.peerId),currentPeer)).join('') : '<option>还没有聊天记录</option>'
  $('peer').disabled = !peers.length; $('contactContext').hidden = peers.length <= 1
  $('peer').onchange = () => {
    if (!leaveChat()) { $('peer').value = currentPeer; return }
    currentPeer = $('peer').value; void run(null,changePeer)
  }
  await changePeer(); if (admin) await refreshStatus()
  $('colophon').textContent = '数据保存在本机 · 读取于 ' + new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})
}
`
