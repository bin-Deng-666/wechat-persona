/** 设置页 HTTP 路由与联系人权限检查，传输层不持有业务状态。 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PanelRoutes } from './routes.ts'

export const PANEL_ROUTES: Record<string,{method:'GET' | 'POST';action:keyof PanelRoutes}> = {
  '/panel':{method:'GET',action:'page'}, '/access':{method:'GET',action:'access'}, '/status':{method:'GET',action:'status'},
  '/begin':{method:'POST',action:'begin'}, '/poll':{method:'POST',action:'poll'}, '/verify-code':{method:'POST',action:'verifyCode'}, '/logout':{method:'POST',action:'logout'},
  '/personas':{method:'GET',action:'personas'}, '/persona':{method:'GET',action:'readPersona'}, '/persona/save':{method:'POST',action:'writePersona'},
  '/chats':{method:'GET',action:'chats'}, '/chat':{method:'POST',action:'setChat'}, '/chat/control':{method:'POST',action:'control'},
  '/memory':{method:'GET',action:'memory'}, '/memory/save':{method:'POST',action:'saveMemory'}, '/memory/delete':{method:'POST',action:'deleteMemory'}, '/memory/clear':{method:'POST',action:'clearMemory'},
  '/stickers':{method:'GET',action:'stickers'}, '/sticker/image':{method:'GET',action:'stickerImage'}, '/sticker/save':{method:'POST',action:'saveSticker'}, '/sticker/forget':{method:'POST',action:'forgetSticker'}, '/sticker/publish':{method:'POST',action:'publishSticker'}, '/sticker/unpublish':{method:'POST',action:'unpublishSticker'},
}
export interface PanelGrant { admin:boolean; peerId?:string }
export async function dispatchPanel(panel: PanelRoutes,request: Request,path: string,grant: PanelGrant): Promise<Response> {
  const route = PANEL_ROUTES[path === '' ? '/panel' : path]
  if (!route) return Response.json({error:'没有这个地址'},{status:404})
  if (request.method !== route.method) return Response.json({error:'方法不允许'},{status:405})
  if (!grant.admin) {
    const free = ['/panel','/access','/chats','/personas']
    const own = ['/chat','/chat/control','/memory','/memory/save','/memory/delete','/memory/clear','/stickers','/sticker/image','/sticker/save','/sticker/forget']
    if (!free.includes(path)) {
      if (!own.includes(path)) return Response.json({error:'需要管理员权限'},{status:403})
      let peer: unknown
      if (route.method === 'GET') peer = new URL(request.url).searchParams.get('peerId')
      else { try { peer = (await request.clone().json() as {peerId?:unknown} | null)?.peerId } catch { return Response.json({error:'请求体必须是 JSON'},{status:400}) } }
      if (!grant.peerId || peer !== grant.peerId) return Response.json({error:'只能管理自己的聊天'},{status:403})
    }
    if (path === '/chats') {
      const chats = await (await panel.chats()).json() as {peerId:string}[]
      return Response.json(chats.filter(chat => chat.peerId === grant.peerId))
    }
  }
  return await (panel[route.action] as (request: Request) => Promise<Response> | Response)(request)
}
export function createPanelHandler(handle: (request: Request,remote: string) => Promise<Response>) {
  return async (req: IncomingMessage,res: ServerResponse): Promise<void> => {
    res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY')
    try {
      let body: Buffer | undefined
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks: Buffer[] = []; let size = 0
        for await (const part of req) {
          const chunk = Buffer.from(part); size += chunk.length
          if (size > 1024 * 1024) { res.writeHead(413); res.end(JSON.stringify({error:'内容超过 1 MiB'})); return }
          chunks.push(chunk)
        }
        body = Buffer.concat(chunks)
      }
      const headers = new Headers()
      for (const [name,value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name,Array.isArray(value) ? value.join(', ') : value)
      const request = new Request(`http://${req.headers.host || 'localhost'}${req.url || '/'}`,{method:req.method || 'GET',headers,...(body ? {body:body as unknown as BodyInit} : {})})
      const response = await handle(request,req.socket.remoteAddress || 'local')
      response.headers.forEach((value,key) => res.setHeader(key,value)); res.writeHead(response.status)
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()))
    } catch {
      if (!res.headersSent) res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'})
      if (!res.writableEnded) res.end(JSON.stringify({error:'设置操作未完成，请刷新重试。'}))
    }
  }
}
