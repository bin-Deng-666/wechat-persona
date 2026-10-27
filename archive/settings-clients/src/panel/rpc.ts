/** 私有 Unix socket RPC。只承载本机控制，不把 DSH 接口暴露到局域网。 */
import { createServer, request, type Server } from 'node:http'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function rpcCall<T>(socketPath: string,method: string,args: unknown = {},timeoutMs = 5000): Promise<T> {
  return await new Promise<T>((resolve,reject) => {
    const req = request({socketPath,path:'/rpc',method:'POST',headers:{'Content-Type':'application/json'}},res => {
      const chunks: Buffer[] = []
      res.on('data',chunk => chunks.push(Buffer.from(chunk)))
      res.on('end',() => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {value:T;error?:string}
          if (res.statusCode !== 200) reject(new Error(body.error || '本机服务请求失败'))
          else resolve(body.value)
        } catch (error) { reject(error) }
      })
    })
    req.setTimeout(timeoutMs,() => req.destroy(new Error('本机服务暂时没有响应')))
    req.on('error',reject); req.end(JSON.stringify({method,args}))
  })
}
export async function serveRpc(socketPath: string,dispatch: (method: string,args: unknown) => Promise<unknown>): Promise<() => Promise<void>> {
  await mkdir(dirname(socketPath),{recursive:true,mode:0o700})
  try {
    const info = await lstat(socketPath)
    if (!info.isSocket()) throw new Error('控制 socket 路径被其他文件占用')
    let active = false
    try { await rpcCall(socketPath,'health',{},1000); active = true } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ECONNREFUSED' && code !== 'ENOENT') throw error
    }
    if (active) throw new Error('已有一个进程正在提供此服务')
    await unlink(socketPath)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const server: Server = createServer(async (req,res) => {
    const send = (status: number,value: unknown) => { res.writeHead(status,{'Content-Type':'application/json'}); res.end(JSON.stringify(value)) }
    if (req.method !== 'POST' || req.url !== '/rpc') { send(404,{error:'没有这个接口'}); return }
    try {
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 1024 * 1024) { send(413,{error:'请求过大'}); return }
        chunks.push(Buffer.from(chunk))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {method?:unknown;args?:unknown}
      if (typeof body.method !== 'string') { send(400,{error:'缺少方法名'}); return }
      send(200,{value:body.method === 'health' ? {ok:true} : await dispatch(body.method,body.args)})
    } catch (error) { send(422,{error:error instanceof Error ? error.message : String(error)}) }
  })
  server.requestTimeout = 15000
  await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(socketPath,() => { server.removeListener('error',reject); resolve() }) })
  await chmod(socketPath,0o600)
  server.on('error',() => {}); server.unref()
  return async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    await unlink(socketPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
  }
}
