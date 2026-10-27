/** 固定入口、一次登录、服务重启、设备撤销和原生小程序的真实 HTTP 回归。 */
import assert from 'node:assert/strict'
import { get as httpGet } from 'node:http'
import { mkdtemp,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe,it,type TestContext } from 'node:test'
import { SettingsServer,lanAddress } from '../../src/panel/server.ts'
import { SettingsRepository } from '../../src/panel/repository.ts'
import { PUBLIC_PREFIX } from '../../src/panel/routes.ts'

async function fixture(t: TestContext) {
  const root=await mkdtemp(join(tmpdir(),'settings-server-')), repository=new SettingsRepository(root)
  await repository.setChat({peerId:'alice',enabled:true}); await repository.setChat({peerId:'bob',enabled:true})
  const idle={phase:'idle' as const,message:''}
  const handlers=repository.handlers({status:async()=>({connected:false,botOnline:false,login:idle,dataDir:root}),begin:async()=>idle,poll:async()=>idle,verifyCode:async()=>idle,logout:async()=>idle,control:async()=>({ok:false,message:'Bot 离线'})})
  const options={dataDir:root,config:{version:1 as const,host:'127.0.0.1',port:0,localName:'Settings.local'},ipc:false}
  const servers:SettingsServer[]=[]
  const start=async()=>{const server=new SettingsServer(handlers,options);servers.push(server);const links=await server.start();return{server,links,origin:new URL(links.localUrl).origin}}
  t.after(async()=>{for(const server of servers)await server.close();await rm(root,{recursive:true,force:true})})
  return {...await start(),start,repository}
}
async function exchange(origin:string,url:string,native=false) {
  const token=new URLSearchParams(new URL(url).hash.slice(1)).get('login')
  const response=await fetch(origin+PUBLIC_PREFIX+'/auth/exchange',{method:'POST',headers:{'Content-Type':'application/json','X-Settings-Request':'1',...(native?{'X-Settings-Client':'miniprogram'}:{})},body:JSON.stringify({token})})
  return {response,cookie:response.headers.get('Set-Cookie')?.split(';')[0]||'',body:await response.json() as {token?:string}}
}
function request(origin:string,path:string,cookie:string,body?:unknown) {
  return fetch(origin+PUBLIC_PREFIX+path,{headers:{Cookie:cookie,...(body!==undefined?{'Content-Type':'application/json','X-Settings-Request':'1'}:{})},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})})
}

describe('独立设置服务',()=>{
  it('固定页面无需凭据；数据需登录，登录票据一次消费',async t=>{
    const f=await fixture(t)
    assert.equal((await fetch(f.links.localUrl)).status,200)
    assert.equal((await request(f.origin,'/chats','')).status,401)
    const pair=await f.links.forPeer('alice',false), session=await exchange(f.origin,pair.url)
    assert.equal(session.response.status,200); assert.match(session.response.headers.get('Set-Cookie')!,/HttpOnly/)
    assert.equal(session.body.token,undefined)
    assert.equal((await exchange(f.origin,pair.url)).response.status,401)
    assert.deepEqual(await(await request(f.origin,'/chats',session.cookie)).json(),[{peerId:'alice',enabled:true}])
    assert.equal((await request(f.origin,'/memory?peerId=bob',session.cookie)).status,403)
    assert.equal((await request(f.origin,'/chat',session.cookie,{peerId:'bob',enabled:false})).status,403)
    assert.equal((await request(f.origin,'/persona/save',session.cookie,{id:'x',raw:'{}'})).status,403)
    assert.equal((await request(f.origin,'/chat',session.cookie,{peerId:'alice',maxChars:220})).status,200)
  })
  it('保持登录跨服务重启；撤销设备后不再接受同一个 cookie',async t=>{
    const f=await fixture(t), pair=await f.links.forPeer('alice',true), session=await exchange(f.origin,pair.url)
    await f.server.close()
    const restarted=await f.start()
    assert.equal((await request(restarted.origin,'/chats',session.cookie)).status,200)
    const devices=await(await request(restarted.origin,'/auth/devices',session.cookie)).json() as {devices:{id:string;current:boolean}[]}
    assert.equal(devices.devices.length,1)
    assert.equal((await request(restarted.origin,'/auth/revoke',session.cookie,{id:devices.devices[0]!.id})).status,200)
    assert.equal((await request(restarted.origin,'/chats',session.cookie)).status,401)
  })
  it('小程序收到独立 bearer 会话；拥有同样的联系人边界',async t=>{
    const f=await fixture(t), pair=await f.links.forPeer('bob',false), session=await exchange(f.origin,pair.url,true)
    assert.ok(session.body.token); assert.equal(session.cookie,'')
    const native=(path:string)=>fetch(f.origin+PUBLIC_PREFIX+path,{headers:{Authorization:'Bearer '+session.body.token}})
    assert.deepEqual(await(await native('/chats')).json(),[{peerId:'bob',enabled:true}])
    assert.equal((await native('/memory?peerId=alice')).status,403)
    assert.equal((await native('/guide')).status,200)
  })
  it('跨站请求不能修改设置；返回可安装的公开 manifest',async t=>{
    const f=await fixture(t), session=await exchange(f.origin,(await f.links.forPeer('alice',true)).url)
    const rejected=await fetch(f.origin+PUBLIC_PREFIX+'/chat',{method:'POST',headers:{Cookie:session.cookie,'Content-Type':'application/json',Origin:'https://other.test','X-Settings-Request':'1'},body:JSON.stringify({peerId:'alice',enabled:false})})
    assert.equal(rejected.status,403)
    const hostStatus=(host:string)=>new Promise<number>((resolve,reject)=>{const req=httpGet(f.links.localUrl,{headers:{Host:host}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!))});req.on('error',reject)})
    assert.equal(await hostStatus('settings.local'),200)
    assert.equal(await hostStatus('other.test'),403)
    const manifest=await(await fetch(f.origin+PUBLIC_PREFIX+'/manifest.webmanifest')).json() as {start_url:string;display:string}
    assert.equal(manifest.start_url,PUBLIC_PREFIX+'/panel'); assert.equal(manifest.display,'standalone')
    assert.equal((await fetch(f.origin+PUBLIC_PREFIX+'/apple-touch-icon.png')).headers.get('Content-Type'),'image/png')
    const worker=await(await fetch(f.origin+PUBLIC_PREFIX+'/service-worker.js')).text()
    assert.doesNotThrow(()=>new Function(worker))
  })
  it('局域网地址忽略 VPN 与 loopback',()=>{
    const address=(ip:string,internal=false)=>({address:ip,family:'IPv4' as const,internal,netmask:'255.255.255.0',mac:'00:00:00:00:00:00',cidr:null})
    assert.equal(lanAddress({utun0:[address('10.9.0.1')],en0:[address('192.168.1.6')]}),'192.168.1.6')
    assert.equal(lanAddress({lo0:[address('127.0.0.1',true)]}),'127.0.0.1')
  })
})
