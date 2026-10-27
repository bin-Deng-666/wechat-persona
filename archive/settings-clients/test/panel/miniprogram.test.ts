/** 小程序客户端用真实 HTTP 服务验证绑定、长期凭据与联系人隔离；wx.request 仅作传输适配。 */
import assert from 'node:assert/strict'
import { readFile,mkdtemp,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { it } from 'node:test'
import { SettingsRepository } from '../../src/panel/repository.ts'
import { SettingsServer } from '../../src/panel/server.ts'

it('原生客户端绑定后使用 bearer，读写自己的设置并拒绝其他联系人',async t=>{
 const root=await mkdtemp(join(tmpdir(),'miniapp-api-')),repo=new SettingsRepository(root),idle={phase:'idle' as const,message:''}
 const handlers=repo.handlers({status:async()=>({botOnline:false,connected:false,login:idle,dataDir:root}),begin:async()=>idle,poll:async()=>idle,logout:async()=>idle,verifyCode:async()=>idle})
 await repo.setChat({peerId:'alice',enabled:true});await repo.setChat({peerId:'bob',enabled:true})
 const server=new SettingsServer(handlers,{dataDir:root,ipc:false,config:{version:1,host:'127.0.0.1',port:0}}),links=await server.start(),origin=new URL(links.localUrl).origin
 t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true})})
 const storage=new Map<string,string>(),app={globalData:{peerId:''}},module={exports:{} as Record<string,unknown>}
 const wx={getStorageSync:(key:string)=>storage.get(key)||'',setStorageSync:(key:string,value:string)=>storage.set(key,value),removeStorageSync:(key:string)=>storage.delete(key),reLaunch:({complete}:{complete:()=>void})=>complete(),request:(options:{url:string;method:string;header:Record<string,string>;data?:unknown;success:(value:unknown)=>void;fail:()=>void})=>{
   const url=new URL(options.url)
   void fetch(origin+url.pathname+url.search,{method:options.method,headers:options.header,...(options.data===undefined?{}:{body:JSON.stringify(options.data)})}).then(async response=>options.success({statusCode:response.status,data:await response.json()})).catch(options.fail)
 }}
 runInNewContext(await readFile('miniprogram/utils/api.js','utf8'),{module,require:()=>({apiBase:'https://settings.test'}),wx,getApp:()=>app,Map,Promise,Error,encodeURIComponent},{filename:'api.js'})
 const api=module.exports as {bind:(code:string)=>Promise<void>;request:(path:string,body?:unknown)=>Promise<unknown>;context:()=>Promise<{peer:string}>}
 const pair=await links.forPeer('alice',false)
 await api.bind(pair.code!)
 assert.equal((await api.context()).peer,'alice')
 await api.request('/chat',{peerId:'alice',maxChars:240})
 assert.equal((await repo.settings.get('alice')).maxChars,240)
 await assert.rejects(api.request('/memory?peerId=bob'),/自己的/)
 await api.request('/memory/save',{peerId:'alice',title:'测试偏好',content:'使用简洁清楚的表达。',type:'稳定偏好',scope:'测试',certainty:'明确',tags:[]})
 assert.equal(repo.memory.get('alice').length,1)
 assert.equal(repo.memory.get('bob').length,0)
 assert.equal(storage.size,1)
})
