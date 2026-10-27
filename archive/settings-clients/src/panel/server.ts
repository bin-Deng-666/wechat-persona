/** 固定端口的独立设置服务；会话持久化，关闭 DSH 不会关闭网页。 */
import { createServer, type Server } from 'node:http'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { createPanel, PUBLIC_PATH, PUBLIC_PREFIX, type PanelHandlers } from './routes.ts'
import { createPanelHandler, dispatchPanel, type PanelGrant } from './http.ts'
import { settingsGuide } from './guide.ts'
import { DeviceAuth, validateGrant } from './auth.ts'
import { appAsset } from './assets.ts'
import { entryAddresses, controlSocket, lanAddress, loadSettingsConfig, localOrigin, settingsDir, type SettingsConfig } from './config.ts'
import { serveRpc } from './rpc.ts'

export { lanAddress } from './config.ts'
export interface SettingsEntry { url:string; code?:string; alternates?:string[]; scope:'public'|'lan'|'local' }
export interface SettingsLinks { localUrl:string; forPeer:(peerId:string,admin:boolean) => Promise<SettingsEntry> | SettingsEntry }
export interface SettingsServerOptions { dataDir:string; config?:SettingsConfig; ipc?:boolean }
const jsonError = (error:string,status = 400) => Response.json({error},{status})

export class SettingsServer {
  private readonly handlers: PanelHandlers
  private readonly options: SettingsServerOptions
  private readonly auth: DeviceAuth
  private server: Server | undefined
  private config: SettingsConfig | undefined
  private closeRpc: (() => Promise<void>) | undefined
  private readonly attempts = new Map<string,{count:number;until:number}>()
  constructor(handlers: PanelHandlers,options: SettingsServerOptions) {
    this.handlers = handlers; this.options = options
    this.auth = new DeviceAuth(join(settingsDir(options.dataDir),'sessions.json'))
  }
  handler = createPanelHandler(async (request,remote) => await this.handle(request,remote))
  private pairing(grant: PanelGrant) {
    if (!this.config) throw new Error('设置服务尚未启动')
    const pair = this.auth.issue(grant), addresses = entryAddresses(this.config), url = new URL(addresses.primary + PUBLIC_PATH)
    if (grant.peerId) url.searchParams.set('peer',grant.peerId)
    url.hash = 'login=' + pair.token
    return {url:url.href,code:pair.code,expiresAt:pair.expiresAt,address:addresses.primary + PUBLIC_PATH,scope:addresses.scope,alternates:addresses.alternates.map(base => base + PUBLIC_PATH)}
  }
  async start(): Promise<SettingsLinks> {
    this.config = this.options.config ?? await loadSettingsConfig(this.options.dataDir)
    const server = createServer(this.handler); this.server = server
    server.requestTimeout = 15000; server.headersTimeout = 10000
    try {
      await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(this.config!.port,this.config!.host,() => { server.removeListener('error',reject); resolve() }) })
      server.on('error',() => {})
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('无法取得设置服务端口')
      this.config = {...this.config,port:address.port}
      if (this.options.ipc !== false) this.closeRpc = await serveRpc(controlSocket(this.options.dataDir),async (method,args) => {
        if (method !== 'pair') throw new Error('没有这个控制方法')
        return this.pairing(validateGrant(args))
      })
      return {localUrl:localOrigin(this.config) + PUBLIC_PATH,forPeer:(peerId,admin) => this.pairing({peerId,admin})}
    } catch (error) { await this.close(); throw error }
  }
  private allowHost(url: URL): boolean {
    const config = this.config!
    const allowed = ['127.0.0.1','localhost','[::1]',lanAddress(),hostname(),config.localName]
    if (config.publicUrl) allowed.push(new URL(config.publicUrl).hostname)
    return allowed.some(host => typeof host === 'string' && host.toLowerCase() === url.hostname.toLowerCase())
  }
  private async handle(request: Request,remote: string): Promise<Response> {
    const url = new URL(request.url), config = this.config
    if (!config) return jsonError('服务正在启动',503)
    if (!this.allowHost(url)) return jsonError('不允许的访问地址',403)
    if (url.pathname === '/' && request.method === 'GET') return new Response(null,{status:302,headers:{Location:PUBLIC_PATH}})
    if (!url.pathname.startsWith(PUBLIC_PREFIX + '/')) return jsonError('没有这个地址',404)
    const path = url.pathname.slice(PUBLIC_PREFIX.length)
    if (request.method === 'GET') {
      const asset = appAsset(path); if (asset) return asset
      if (path === '/panel') return createPanel(this.handlers).page()
      if (path === '/health') return Response.json({settingsOnline:true})
    }
    if (request.method === 'POST') {
      const origin = request.headers.get('Origin')
      if (request.headers.get('X-Settings-Request') !== '1' || (origin && origin !== url.origin && origin !== config.publicUrl)) return jsonError('请从设置页提交操作',403)
    }
    const secure = !!config.publicUrl && url.host === new URL(config.publicUrl).host
    if (path === '/auth/exchange' && request.method === 'POST') {
      const now = Date.now(), attempts = this.attempts.get(remote)
      if (attempts && attempts.until > now && attempts.count >= 10) return jsonError('尝试次数过多，请十分钟后重试',429)
      if (this.attempts.size > 1000) for (const [key,value] of this.attempts) if (value.until <= now) this.attempts.delete(key)
      this.attempts.set(remote,{count:attempts && attempts.until > now ? attempts.count + 1 : 1,until:attempts && attempts.until > now ? attempts.until : now + 600000})
      let body: {code?:unknown;token?:unknown}
      try { body = await request.json() as typeof body } catch { return jsonError('请输入有效验证码') }
      const value = body && (typeof body.token === 'string' ? body.token : typeof body.code === 'string' ? body.code : '')
      if (!value || value.length > 256) return jsonError('请输入验证码')
      try {
        const session = await this.auth.exchange(value,request.headers.get('User-Agent') || '')
        const native = request.headers.get('X-Settings-Client') === 'miniprogram'
        return Response.json({ok:true,peerId:session.device.grant.peerId,...(native ? {token:session.cookie} : {})},{headers:native ? {} : {'Set-Cookie':this.auth.cookie(session.cookie,secure)}})
      } catch (error) { return jsonError(error instanceof Error ? error.message : '登录未完成',401) }
    }
    const device = await this.auth.authenticate(request.headers.get('Authorization') || request.headers.get('Cookie') || '')
    if (!device) return jsonError('请先登录设置页',401)
    if (path === '/guide' && request.method === 'GET') return Response.json(settingsGuide)
    if (path === '/auth/devices' && request.method === 'GET') return Response.json({devices:await this.auth.devices(device)})
    if (path === '/auth/link' && request.method === 'POST') return Response.json(this.pairing(device.grant))
    if (path === '/auth/logout' && request.method === 'POST') {
      await this.auth.revoke(device,device.id)
      return Response.json({ok:true},{headers:{'Set-Cookie':this.auth.cookie('',secure,true)}})
    }
    if (path === '/auth/revoke' && request.method === 'POST') {
      let body: {id?:unknown}
      try { body = await request.json() as typeof body } catch { return jsonError('请求不合法') }
      if (!body || typeof body.id !== 'string') return jsonError('缺少设备')
      try { await this.auth.revoke(device,body.id); return Response.json({ok:true}) }
      catch { return jsonError('只能管理自己的设备',403) }
    }
    if (path === '/access' && request.method === 'GET') {
      const status = await this.handlers.status()
      const addresses = entryAddresses(config)
      return Response.json({admin:device.grant.admin,peerId:device.grant.peerId,botOnline:status.botOnline ?? status.connected,address:addresses.primary + PUBLIC_PATH,scope:addresses.scope,alternates:addresses.alternates.map(base => base + PUBLIC_PATH)})
    }
    return await dispatchPanel(createPanel(this.handlers,undefined,device.grant.admin),request,path,device.grant)
  }
  async close(): Promise<void> {
    if (this.closeRpc) { await this.closeRpc(); this.closeRpc = undefined }
    const server = this.server; this.server = undefined
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  }
}
