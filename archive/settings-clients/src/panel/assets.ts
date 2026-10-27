/** 桌面入口的公开静态资源。所有私有 API 与素材均不缓存。 */
import { PNG } from 'pngjs'
import { PUBLIC_PREFIX, PUBLIC_PATH } from './routes.ts'

export const appIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="44" fill="#18181b"/><g fill="none" stroke="#fafafa" stroke-width="8" stroke-linecap="round"><rect x="46" y="56" width="100" height="88" rx="24"/><path d="M96 36v20M76 116h40M75 88h1M116 88h1"/></g></svg>'
let appleIcon: Buffer | undefined
function iconPng(): Buffer {
  if (appleIcon) return appleIcon
  const png = new PNG({width:192,height:192})
  for (let y = 0;y < 192;y++) for (let x = 0;x < 192;x++) {
    const outline = x >= 46 && x <= 146 && y >= 56 && y <= 144 && (x < 53 || x > 139 || y < 63 || y > 137)
    const antenna = x >= 92 && x <= 100 && y >= 36 && y <= 56
    const eyes = ((x-76)**2+(y-88)**2 < 25) || ((x-116)**2+(y-88)**2 < 25)
    const mouth = x >= 76 && x <= 116 && y >= 112 && y <= 120
    const color = outline || antenna || eyes || mouth ? 250 : 24, offset = (y*192+x)*4
    png.data[offset] = color; png.data[offset+1] = color; png.data[offset+2] = color + (color === 24 ? 3 : 0); png.data[offset+3] = 255
  }
  appleIcon = PNG.sync.write(png); return appleIcon
}
export function appAsset(path: string): Response | undefined {
  if (path === '/manifest.webmanifest') return Response.json({
    id:PUBLIC_PREFIX + '/',name:'设置',short_name:'设置',lang:'zh-CN',start_url:PUBLIC_PATH,scope:PUBLIC_PREFIX + '/',display:'standalone',background_color:'#f7f7f8',theme_color:'#18181b',
    icons:[{src:PUBLIC_PREFIX + '/icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any maskable'},{src:PUBLIC_PREFIX + '/apple-touch-icon.png',sizes:'192x192',type:'image/png'}],
  },{headers:{'Content-Type':'application/manifest+json; charset=utf-8'}})
  if (path === '/icon.svg') return new Response(appIcon,{headers:{'Content-Type':'image/svg+xml'}})
  if (path === '/apple-touch-icon.png') return new Response(iconPng() as unknown as BodyInit,{headers:{'Content-Type':'image/png'}})
  if (path === '/service-worker.js') return new Response(`
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  if(event.request.mode!=='navigate') return;
  event.respondWith(fetch(event.request).catch(()=>new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>设置</title><body style="font:16px/1.7 system-ui;padding:32px"><h2>暂时连接不上设置服务</h2><p>请检查网络和运行服务的设备，再刷新页面。</p><button onclick="location.reload()">重新连接</button></body></html>',{headers:{'Content-Type':'text/html; charset=utf-8'}})));
});`,{headers:{'Content-Type':'text/javascript; charset=utf-8','Service-Worker-Allowed':PUBLIC_PREFIX + '/'}})
  return undefined
}
