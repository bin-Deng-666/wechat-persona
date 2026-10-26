/**
 * 浏览器配置页。
 *
 * 路由全部挂在 `/api/persona-wechat/*` 下：宿主的 token fence 覆盖 `/api`，
 * 注册在别处的路由任何本机进程都能访问。
 *
 * 页面刻意做成单文件（内联 HTML/CSS/JS）：这一版只解决「扫码登录 + 看到状态 + 管人格」，
 * 不引入客户端打包链路。等需要「按聊天改设置」时再升级成 bundle client。
 *
 * @module wechat-persona/channel/panel
 */

import type { LoginView } from './login-session.ts'

/** 所有路由共用的前缀，也是它们被认证的原因。 */
export const PANEL_PREFIX = '/api/persona-wechat'

/** 页面路径。 */
export const PANEL_PATH = `${PANEL_PREFIX}/panel`

/** 面板需要的最小接口。 */
export interface PanelHandlers {
  /** 只读状态。 */
  status: () => Promise<PanelStatus>
  /** 开始一次登录。 */
  begin: () => Promise<LoginView>
  /** 轮询一次扫码状态。 */
  poll: () => Promise<LoginView>
  /** 提交验证码。 */
  verifyCode: (code: string) => Promise<LoginView>
  /** 退出登录。 */
  logout: () => Promise<LoginView>
  /** 人格卡概览。 */
  personas: () => Promise<PersonaSummary[]>
}

export interface PanelStatus {
  /** 是否已登录。 */
  connected: boolean
  /** 登录的微信号（可能为空）。 */
  userId?: string
  /** 登录视图。 */
  login: LoginView
  /** 数据目录，显示给用户找他的人格卡。 */
  dataDir: string
}

export interface PersonaSummary {
  id: string
  name: string
  description: string
  /** 校验告警。 */
  warnings: string[]
}

export interface PanelRoutes {
  page: () => Response
  status: () => Promise<Response>
  begin: () => Promise<Response>
  poll: () => Promise<Response>
  verifyCode: (request: Request) => Promise<Response>
  logout: () => Promise<Response>
  personas: () => Promise<Response>
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/**
 * 构造路由处理器。
 * @param handlers - 面板背后的真实动作。
 */
export function createPanel(handlers: PanelHandlers): PanelRoutes {
  return {
    page: () => new Response(renderPage(), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    }),
    status: async () => json(await handlers.status()),
    begin: async () => json(await handlers.begin()),
    poll: async () => json(await handlers.poll()),
    verifyCode: async request => {
      let code = ''
      try {
        const body = (await request.json()) as { code?: unknown }
        if (typeof body.code === 'string') code = body.code.trim()
      } catch {
        return json({ error: '请求体必须是 JSON：{"code":"123456"}' }, 400)
      }
      if (!/^\d{4,8}$/u.test(code)) return json({ error: '验证码应为 4-8 位数字' }, 400)
      return json(await handlers.verifyCode(code))
    },
    logout: async () => json(await handlers.logout()),
    personas: async () => json(await handlers.personas()),
  }
}

/** 页面本身：足够小，不需要构建。 */
function renderPage(): string {
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
  </div>

<script>
const P = '${PANEL_PREFIX}'
const $ = id => document.getElementById(id)
let timer

async function post(path, body) {
  const res = await fetch(P + path, {
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
  const res = await fetch(P + '/status')
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

const res = await fetch(P + '/personas')
const list = await res.json()
$('personas').innerHTML = list.length === 0
  ? '还没有人格卡。在数据目录下建 <code>personas/&lt;id&gt;/persona.json</code>（可参考 examples/personas/xiao-jing）。'
  : '<ul>' + list.map(p => '<li><b>' + p.name + '</b> <code>' + p.id + '</code>' + (p.description ? ' — ' + p.description : '') + '</li>').join('') + '</ul>'

refresh()
</script>
</body>
</html>`
}
