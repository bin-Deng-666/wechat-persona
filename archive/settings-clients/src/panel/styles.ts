/** 设置页的样式；渲染时内联，浏览器无需加载任何外部资源。 */
export const panelStyles = String.raw`
:root {
  --bg:#f7f7f8; --card:#ffffff; --card-fg:#202024;
  --primary:#242428; --primary-fg:#ffffff; --primary-hover:#3f3f46;
  --secondary:#f1f1f3; --secondary-fg:#3f3f46; --muted:#f7f7f8; --muted-fg:#71717a;
  --border:#e7e7eb; --input:#dedee4; --ring:#8b8b95; --ok:#15803d; --err:#dc2626;
  --ok-bg:#f0fdf4; --err-bg:#fef2f2; --qr-bg:#ffffff;
  --radius:10px; --radius-sm:7px; --radius-lg:14px;
  --shadow-sm:0 1px 2px rgb(0 0 0 / .025);
  --shadow-lg:0 18px 60px rgb(0 0 0 / .14); color-scheme:light;
}
[data-theme="dark"] {
  --bg:#111113; --card:#19191c; --card-fg:#f0f0f3;
  --primary:#f0f0f3; --primary-fg:#202024; --primary-hover:#d9d9df;
  --secondary:#27272c; --secondary-fg:#d4d4d8; --muted:#202024; --muted-fg:#a1a1aa;
  --border:#2c2c32; --input:#3b3b43; --ring:#a1a1aa; --ok:#86d6a0; --err:#fca5a5;
  --ok-bg:#14291e; --err-bg:#321e20; color-scheme:dark;
}
*,*::before,*::after { box-sizing:border-box }
[hidden] { display:none !important }
body { margin:0; background:var(--bg); color:var(--card-fg); font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif; -webkit-font-smoothing:antialiased }
button,input,select,textarea { font:inherit; color:inherit }
button,.btn { display:inline-flex; align-items:center; justify-content:center; gap:7px; min-height:38px; padding:8px 13px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--card); color:var(--card-fg); cursor:pointer; text-decoration:none; font-size:13px; font-weight:500; line-height:1.4; transition:background .15s,border-color .15s }
button:hover,.btn:hover { background:var(--secondary) }
button:disabled { opacity:.45; cursor:default }
.primary { background:var(--primary); color:var(--primary-fg); border-color:var(--primary) }
.primary:hover { background:var(--primary-hover) }
.ghost { background:transparent; border-color:transparent }
.danger { color:var(--err) }
.icon-button { width:36px; min-height:36px; padding:8px; flex-shrink:0 }
svg.icon { width:18px; height:18px; flex:none; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round }
:focus-visible { outline:2px solid var(--ring); outline-offset:3px }
h1,h2,h3,p { margin:0 }
h1 { font-size:16px; font-weight:650; letter-spacing:-.3px }
h2 { font-size:24px; font-weight:650; letter-spacing:-.6px; line-height:1.4 }
h3 { font-size:14px; font-weight:600 }
.muted,.hint { color:var(--muted-fg) }
.hint { font-size:12px; margin-top:5px }
header { height:68px; border-bottom:1px solid var(--border); background:var(--card) }
.header-inner { max-width:1160px; height:100%; margin:auto; padding:0 28px; display:flex; align-items:center; justify-content:space-between; gap:16px }
.brand { display:flex; align-items:center; gap:11px }
.brand-mark { display:grid; place-items:center; width:32px; height:32px; border:1px solid var(--border); border-radius:10px; background:var(--secondary) }
.brand-sub { color:var(--muted-fg); font-size:12px }
.header-tools { display:flex; align-items:center; gap:5px }
.more-menu { position:relative; padding:0; border:0 }
.more-menu > summary { list-style:none; display:flex; align-items:center; justify-content:center; width:36px; height:36px; border-radius:var(--radius-sm); cursor:pointer }
.more-menu > summary:hover { background:var(--secondary) }
.more-menu > summary::-webkit-details-marker { display:none }
.menu-popover { position:absolute; right:0; top:44px; width:180px; padding:5px; background:var(--card); border:1px solid var(--border); border-radius:10px; box-shadow:var(--shadow-lg); z-index:20 }
.menu-popover button { width:100%; justify-content:flex-start }
.layout { max-width:1160px; margin:auto; display:grid; grid-template-columns:176px minmax(0,1fr); gap:46px; padding:32px 28px }
.sidebar { align-self:start; position:sticky; top:28px }
.nav-caption { font-size:11px; font-weight:600; color:var(--muted-fg); padding:2px 12px 10px; letter-spacing:.08em }
nav { display:flex; flex-direction:column; gap:5px }
nav a { display:flex; align-items:center; gap:10px; min-height:42px; padding:10px 12px; border-radius:8px; color:var(--muted-fg); text-decoration:none; font-size:13px; white-space:nowrap }
nav a:hover { background:var(--secondary); color:var(--card-fg) }
nav a[aria-current="page"] { background:var(--card); color:var(--card-fg); box-shadow:var(--shadow-sm); font-weight:600 }
nav .nav-divider { border-top:1px solid var(--border); margin:12px 10px }
main { min-width:0; max-width:820px; padding-bottom:20px }
.context-bar { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-bottom:24px; font-size:12px; color:var(--muted-fg) }
.peer-control { display:flex; gap:10px; align-items:center; min-width:0; max-width:100%; font-size:12px; white-space:nowrap }
.peer-control select { padding:6px 30px 6px 10px; max-width:320px; font-size:12px }
.context-details { min-width:0; max-width:100%; position:relative }
.context-details summary { font-size:12px; font-weight:400; color:var(--muted-fg) }
.context-details code { display:block; padding:10px; margin-top:8px; max-width:100%; overflow-wrap:anywhere }
.page-head { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:14px; margin-bottom:23px }
.page-head p { color:var(--muted-fg); margin-top:5px; font-size:13px }
.card { background:var(--card); border:1px solid var(--border); border-radius:var(--radius-lg); box-shadow:var(--shadow-sm); margin-bottom:18px }
.card-body { padding:22px }
.card-title { padding:18px 22px 0; display:flex; align-items:center; justify-content:space-between; gap:12px }
.setting-row { display:flex; align-items:center; justify-content:space-between; gap:24px; padding:19px 0 }
.setting-row + .setting-row { border-top:1px solid var(--border) }
.setting-row:first-child { padding-top:0 }
.setting-row:last-child { padding-bottom:0 }
.setting-row .row-label { min-width:0 }
.setting-row select { max-width:230px }
.field { display:flex; flex-direction:column; gap:7px; font-size:13px; margin-bottom:16px; min-width:0 }
.field > span { font-weight:500 }
.grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0 16px }
input:not([type=checkbox]),select,textarea { width:100%; min-width:0; padding:10px 12px; border:1px solid var(--input); border-radius:var(--radius-sm); background:var(--card); color:var(--card-fg); font-size:13px }
input::placeholder,textarea::placeholder { color:var(--muted-fg) }
textarea { resize:vertical; line-height:1.7 }
.check { display:flex; align-items:center; gap:9px; font-size:13px; cursor:pointer }
input[type=checkbox] { accent-color:var(--primary) }
.switch { appearance:none; position:relative; width:36px; height:22px; flex:none; margin:0; background:var(--input); border:0; border-radius:999px; cursor:pointer; transition:background .15s }
.switch::after { content:""; position:absolute; width:16px; height:16px; top:3px; left:3px; border-radius:50%; background:var(--card); box-shadow:var(--shadow-sm); transition:transform .15s }
.switch:checked { background:var(--primary) }
.switch:checked::after { transform:translateX(14px) }
details.fold { padding:0; border-top:1px solid var(--border) }
summary { cursor:pointer; font-weight:500; font-size:13px; overflow-wrap:anywhere }
details.fold > summary { display:flex; align-items:center; justify-content:space-between; list-style:none; padding:17px 22px }
details.fold > summary::-webkit-details-marker { display:none }
details.fold > summary::after { content:"+"; color:var(--muted-fg); font-size:17px; font-weight:400 }
details.fold[open] > summary::after { content:"−" }
.fold-body { padding:4px 22px 20px }
.fold-body p { margin:0 0 14px; color:var(--muted-fg); font-size:12px }
.form-footer { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; padding:14px 22px; border-top:1px solid var(--border) }
.form-footer .hint { margin:0 }
.toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center }
.actions-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px }
.actions-grid button { display:flex; flex-direction:column; align-items:flex-start; padding:14px; text-align:left; background:var(--card) }
.actions-grid button span { font-size:11px; font-weight:400; color:var(--muted-fg); margin-top:4px }
.filters { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:16px }
.search-box { position:relative; flex:1; min-width:140px }
.search-box svg { position:absolute; top:12px; left:12px; color:var(--muted-fg); pointer-events:none; width:16px; height:16px }
.search-box input { padding-left:37px; background:var(--card) }
.filters select { width:auto; min-width:100px }
.count { display:inline-flex; align-items:center; justify-content:center; min-width:22px; height:22px; padding:0 7px; margin-left:7px; border:1px solid var(--border); border-radius:6px; color:var(--muted-fg); font-size:12px; font-weight:400; vertical-align:middle; letter-spacing:0 }
.badge { display:inline-flex; padding:2px 7px; border-radius:5px; background:var(--secondary); color:var(--muted-fg); font-size:11px; font-weight:400 }
.badge.ready { color:var(--ok); background:var(--ok-bg) }
.memory-item { display:flex; align-items:flex-start; gap:15px; padding:19px 21px }
.memory-item + .memory-item { border-top:1px solid var(--border) }
.memory-item .item-body { flex:1; min-width:0 }
.memory-item .item-title { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:6px }
.memory-item p { color:var(--muted-fg); font-size:13px; white-space:pre-wrap; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden }
.memory-item .icon-button { width:40px; min-height:40px }
.memory-item button { flex:none; margin-top:1px }
.memory-item .item-meta { margin-top:7px; font-size:11px; color:var(--muted-fg) }
.empty { display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; gap:6px; padding:46px 20px; color:var(--muted-fg); font-size:13px }
.empty .empty-icon { display:grid; place-items:center; width:42px; height:42px; border-radius:12px; background:var(--secondary); margin-bottom:7px }
.empty strong { color:var(--card-fg); font-weight:500 }
.gallery { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin-bottom:18px }
.gallery .empty { grid-column:1/-1; border:1px dashed var(--border); border-radius:var(--radius-lg) }
.sticker-card { position:relative; padding:0; border:1px solid var(--border); border-radius:var(--radius-lg); background:var(--card); overflow:hidden; text-align:left; display:flex; flex-direction:column; align-items:stretch; min-width:0; box-shadow:var(--shadow-sm) }
.sticker-card:hover { border-color:var(--ring); background:var(--card) }
.sticker-card .image-well { display:grid; place-items:center; aspect-ratio:1.35; padding:20px; background:var(--muted); border-bottom:1px solid var(--border) }
.sticker-card img { width:100%; height:130px; object-fit:contain; min-width:0 }
.sticker-card .sticker-meta { display:flex; align-items:center; justify-content:space-between; gap:5px; padding:11px 12px; min-width:0 }
.sticker-card strong { font-size:12px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.shared-list { display:flex; flex-wrap:wrap; gap:8px }
.shared-chip { display:flex; align-items:center; gap:7px; padding:5px 7px 5px 11px; border:1px solid var(--border); border-radius:8px; font-size:12px }
.shared-chip button { width:26px; min-height:26px; padding:4px }
.persona-item { display:flex; align-items:center; gap:13px; padding:18px 21px }
.persona-item + .persona-item { border-top:1px solid var(--border) }
.avatar { width:39px; height:39px; border-radius:11px; display:grid; place-items:center; background:var(--secondary); color:var(--secondary-fg); font-weight:600; flex:none }
.persona-copy { flex:1; min-width:0 }
.persona-copy p { font-size:12px; color:var(--muted-fg); margin-top:3px; overflow-wrap:anywhere }
.help-row { display:grid; grid-template-columns:minmax(150px,.8fr) 1.5fr; gap:16px; padding:12px 0; border-bottom:1px solid var(--border); align-items:start; font-size:13px }
.help-row:last-child { border-bottom:0 }
.help-row span { color:var(--muted-fg) }
code { border-radius:5px; padding:2px 6px; background:var(--secondary); font:12px/1.6 ui-monospace,monospace; overflow-wrap:anywhere }
.faq details + details { border-top:1px solid var(--border) }
.faq summary { padding:15px 0 }
.faq p { color:var(--muted-fg); font-size:13px; padding:0 0 16px }
#feedback { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); max-width:min(560px,calc(100vw - 32px)); padding:12px 17px; border:1px solid var(--border); border-radius:10px; background:var(--card); box-shadow:var(--shadow-lg); z-index:50; font-size:13px; overflow-wrap:anywhere }
#feedback[data-error=true],.dialog-message { color:var(--err) }
#feedback[data-error=false] { color:var(--ok) }
dialog { width:min(560px,calc(100vw - 32px)); max-height:calc(100dvh - 48px); margin:auto; padding:0; border:1px solid var(--border); border-radius:16px; color:var(--card-fg); background:var(--card); box-shadow:var(--shadow-lg); overflow:auto; overscroll-behavior:contain }
dialog::backdrop { background:rgb(0 0 0 / .35); backdrop-filter:blur(3px) }
.dialog-head { position:sticky; top:0; z-index:2; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:17px 22px; border-bottom:1px solid var(--border); background:var(--card) }
.dialog-head h2 { font-size:17px; letter-spacing:-.2px }
.dialog-body { padding:22px }
.dialog-body .field:last-child { margin-bottom:0 }
.dialog-actions { position:sticky; bottom:0; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; padding:15px 22px; border-top:1px solid var(--border); background:var(--card) }
.dialog-message { margin:0 22px 14px; font-size:12px; padding:10px 12px; border-radius:8px; background:var(--err-bg) }
.dialog-image { width:100%; height:150px; object-fit:contain; border-radius:10px; background:var(--muted); margin-bottom:18px }
.editor-advanced { border-top:1px solid var(--border); margin-top:16px; padding-top:15px }
.editor-advanced summary { color:var(--muted-fg); margin-bottom:12px }
.sources { font-size:12px; color:var(--muted-fg); overflow-wrap:anywhere }
.sources blockquote { margin:10px 0; padding:0 0 0 12px; border-left:2px solid var(--border) }
.sources small { display:block; font-size:11px; margin-top:5px }
#personaraw { font:12px/1.7 ui-monospace,monospace }
.qr svg { display:block; width:220px; max-width:100%; height:auto; margin:16px 0; padding:10px; background:var(--qr-bg) }
.status-line { display:flex; align-items:center; gap:8px; font-weight:500 }
.status-dot { width:7px; height:7px; border-radius:50%; background:var(--muted-fg) }
.status-dot.connected { background:var(--ok) }
footer { color:var(--muted-fg); font-size:11px; margin-top:30px }
@media(max-width:760px) {
  header { height:60px } .header-inner { padding:0 18px } .brand-sub { display:none }
  .layout { display:block; padding:0 18px 20px } .sidebar { position:sticky; top:0; margin:0 -18px 22px; padding:0 12px; border-bottom:1px solid var(--border); background:var(--bg); z-index:10 }
  .nav-caption,nav .nav-divider { display:none } nav { flex-direction:row; gap:2px; overflow-x:auto; scrollbar-width:none; padding:9px 0; -webkit-overflow-scrolling:touch } nav::-webkit-scrollbar { display:none }
  nav a { min-height:38px; gap:6px; padding:9px 11px; font-size:12px; flex-shrink:0 } nav a .icon { width:15px; height:15px }
  .context-bar { margin-bottom:19px } .context-details { display:none } .page-head { margin-bottom:18px; gap:10px } h2 { font-size:22px }
  .card-body { padding:18px } .card-title { padding:17px 18px 0 } .setting-row { gap:16px } .setting-row select { max-width:170px } .setting-row:first-child .hint { display:none }
  details.fold > summary { padding:16px 18px } .fold-body { padding:2px 18px 18px } .form-footer { padding:13px 18px }
  .actions-grid { gap:7px } .actions-grid button { align-items:center; text-align:center; padding:14px 6px; font-size:12px } .actions-grid button span { display:none }
  .gallery { grid-template-columns:repeat(2,minmax(0,1fr)); gap:11px } .sticker-card .image-well { padding:13px } .sticker-card img { height:100px } .sticker-card .sticker-meta { flex-wrap:wrap; padding:10px }
  .memory-item,.persona-item { padding:16px } .memory-item { gap:8px } .memory-item .item-title { gap:6px }
  .persona-item { flex-wrap:wrap } .persona-item .toolbar { margin-left:52px }
  .help-row { grid-template-columns:1fr; gap:6px; padding:13px 0 } .help-row code { justify-self:start }
  .grid { grid-template-columns:1fr } .dialog-head { padding:14px 18px } .dialog-body { padding:18px } .dialog-actions { padding:13px 18px } .dialog-message { margin:0 18px 14px }
  dialog { max-height:calc(100dvh - 24px); border-radius:14px } #feedback { bottom:18px }
  .peer-control { flex:1 } .peer-control select { max-width:none; flex:1 }
}
.sign-in { max-width:420px; margin:56px auto; width:calc(100% - 36px) }
.sign-in h2 { font-size:22px }
.sign-in button.primary { width:100% }
.service-badge { font-size:11px; color:var(--muted-fg); margin-right:8px }
.service-badge.online { color:var(--ok) }
.device-item { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:13px 0; border-bottom:1px solid var(--border) }
@media(prefers-reduced-motion:reduce) { * { transition:none !important; scroll-behavior:auto !important } }
@media print { header,.sidebar,button,.filters,.context-bar,#feedback,dialog { display:none !important } .layout { display:block; padding:0 } main { max-width:none } section[hidden] { display:block !important } .card { break-inside:avoid } }
`
