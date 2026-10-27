/** 真实子进程验证文件事务、并发写入和崩溃后的锁恢复。 */
import assert from 'node:assert/strict'
import { mkdtemp,readFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { it } from 'node:test'
import { atomicJson } from '../../src/storage/atomic.ts'
import { withFileLock } from '../../src/storage/lock.ts'

it('多个真实进程增改同一文档不会丢失写入',async t=>{
 const root=await mkdtemp(join(tmpdir(),'settings-lock-')),file=join(root,'state.json')
 t.after(async()=>await rm(root,{recursive:true,force:true}));await atomicJson(file,{count:0})
 const lockUrl=pathToFileURL(join(process.cwd(),'src/storage/lock.ts')).href,atomicUrl=pathToFileURL(join(process.cwd(),'src/storage/atomic.ts')).href
 const code=`import {withFileLock} from ${JSON.stringify(lockUrl)};import {atomicJson} from ${JSON.stringify(atomicUrl)};import {readFile} from 'node:fs/promises';for(let i=0;i<12;i++)await withFileLock(${JSON.stringify(file)},async()=>{const data=JSON.parse(await readFile(${JSON.stringify(file)},'utf8'));await atomicJson(${JSON.stringify(file)},{count:data.count+1})});`
 await Promise.all(Array.from({length:4},async()=>{const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',code],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',data=>{stderr+=data});const [exit]=await once(child,'exit');assert.equal(exit,0,stderr)}))
 assert.equal(JSON.parse(await readFile(file,'utf8')).count,48)
})
it('写入进程异常退出后可以安全恢复，旧数据保留',async t=>{
 const root=await mkdtemp(join(tmpdir(),'settings-lock-crash-')),file=join(root,'state.json')
 t.after(async()=>await rm(root,{recursive:true,force:true}));await atomicJson(file,{count:3})
 const lockUrl=pathToFileURL(join(process.cwd(),'src/storage/lock.ts')).href
 const code=`import {withFileLock} from ${JSON.stringify(lockUrl)};setInterval(()=>{},1000);await withFileLock(${JSON.stringify(file)},async()=>{console.log('locked');await new Promise(()=>{})});`
 const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']})
 t.after(()=>child.kill('SIGKILL'))
 await once(child.stdout,'data');const exit=once(child,'exit');child.kill('SIGKILL');await exit
 await withFileLock(file,async()=>await atomicJson(file,{count:4}))
 assert.equal(JSON.parse(await readFile(file,'utf8')).count,4)
})
