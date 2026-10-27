import assert from 'node:assert/strict'
import { mkdtemp,readFile,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it } from 'node:test'
import { DeviceAuth } from '../../src/panel/auth.ts'

it('长期登录持久化但不保存明文 token；一次性码与会话均按期失效',async t=>{
 const root=await mkdtemp(join(tmpdir(),'settings-auth-'));t.after(async()=>await rm(root,{recursive:true,force:true}))
 let now=1000000000000;const file=join(root,'sessions.json'),auth=new DeviceAuth(file,()=>now)
 const pair=auth.issue({admin:false,peerId:'alice'}),expired=auth.issue({admin:true})
 const session=await auth.exchange(pair.code,'iPhone MicroMessenger')
 assert.equal((await auth.authenticate('Bearer '+session.cookie))?.grant.peerId,'alice')
 await assert.rejects(auth.exchange(pair.token,'Mac'),/失效/)
 assert.ok(!(await readFile(file,'utf8')).includes(session.cookie.split('.')[1]!))
 const restarted=new DeviceAuth(file,()=>now)
 assert.ok(await restarted.authenticate(auth.cookie(session.cookie,false)))
 now+=11*60000;await assert.rejects(auth.exchange(expired.token,''),/失效/)
 now+=91*24*60*60*1000;assert.equal(await restarted.authenticate(auth.cookie(session.cookie,false)),undefined)
})
