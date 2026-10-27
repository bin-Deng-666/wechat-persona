/** DSH 与常驻设置服务的本机桥；插件卸载只关闭 bot 控制端，不关闭网页。 */
import type { Context } from '@deepseek-ai/cordis'
import type { PanelHandlers } from './routes.ts'
import type { SettingsLinks } from './server.ts'
import { controlSocket, hostSocket, loadSettingsConfig, localOrigin } from './config.ts'
import { rpcCall, serveRpc } from './rpc.ts'

export function registerPanel(ctx: Context,dataDir: string,handlers: PanelHandlers,ready: (links: SettingsLinks | undefined) => void): void {
  ctx.effect(() => {
    let disposed = false, close: (() => Promise<void>) | undefined
    void (async () => {
      close = await serveRpc(hostSocket(dataDir),async (method,args) => {
        if (method === 'status') return await handlers.status()
        if (method === 'control') {
          const input = args as {peerId?:unknown;action?:unknown} | null
          if (!input || typeof input.peerId !== 'string' || !['new','stop','compact'].includes(String(input.action))) throw new Error('控制参数不合法')
          if (!handlers.control) throw new Error('Bot 当前离线')
          return await handlers.control(input.peerId,input.action as 'new' | 'stop' | 'compact')
        }
        throw new Error('没有这个 bot 方法')
      })
      if (disposed) { await close(); return }
      const config = await loadSettingsConfig(dataDir)
      ready({localUrl:localOrigin(config) + '/persona-wechat/panel',forPeer:async (peerId,admin) => {
        return await rpcCall<{url:string;code:string;alternates?:string[];scope:'public'|'lan'|'local'}>(controlSocket(dataDir),'pair',{peerId,admin})
      }})
    })().catch(error => ctx.logger('wechat-persona').warn(`设置服务连接未就绪：${String(error)}`))
    return () => { disposed = true; ready(undefined); if (close) void close() }
  })
}
