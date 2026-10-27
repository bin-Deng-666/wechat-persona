/** 设置页使用真实持久化服务，验证人工编辑与重载边界。 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { Coordinator } from '../../src/app/coordinator.ts'
import { StickerLibrary } from '../../../../src/stickers/library.ts'

it('未登录时也先加载已有记忆；人工编辑检查版本，删除后不重建',async t => {
  const root = await mkdtemp(join(tmpdir(),'wechat-panel-memory-'))
  const coordinators: Coordinator[] = []
  const open = () => {
    const config = {logRetentionDays:{get:()=>7}}
    const ctx = {logger:()=>({info:()=>{},warn:()=>{}})}
    const coordinator = new Coordinator(ctx as never,config as never,root)
    coordinators.push(coordinator); return coordinator.panelHandlers()
  }
  t.after(async()=>{ for (const coordinator of coordinators) await coordinator.dispose(); await rm(root,{recursive:true,force:true}) })
  const input = {peerId:'alice',title:'测试偏好',content:'回答使用简单直接的文字。',type:'稳定偏好',scope:'沟通方式',certainty:'明确',tags:['测试']}
  const first = open()
  assert.equal((await first.saveMemory(input)).ok,true)
  assert.equal((await first.saveMemory({...input,peerId:'bob'})).ok,true)
  const reloaded = open()
  const memory = (await reloaded.memory('alice')).memories[0]!
  assert.equal(memory.content,input.content)
  assert.deepEqual(memory.sources,[])
  assert.equal((await reloaded.saveMemory({...input,id:memory.id,version:memory.version,content:'更新后的沟通偏好。'})).ok,true)
  assert.equal((await reloaded.saveMemory({...input,id:memory.id,version:memory.version})).ok,false)
  assert.equal((await reloaded.deleteMemory({peerId:'alice',id:memory.id,version:memory.version})).ok,false)
  assert.equal((await reloaded.deleteMemory({peerId:'alice',id:memory.id,version:2})).ok,true)
  const afterDelete = open()
  assert.deepEqual((await afterDelete.memory('alice')).memories,[])
  assert.equal((await afterDelete.saveMemory({...input,content:'更新后的沟通偏好。'})).ok,false)
  assert.equal((await afterDelete.memory('bob')).memories.length,1)
})

it('表情可清空名字、忽略、共享和移出；不删除其他联系人原件',async t => {
  const root = await mkdtemp(join(tmpdir(),'wechat-panel-stickers-'))
  t.after(async()=>await rm(root,{recursive:true,force:true}))
  const library = new StickerLibrary(root)
  const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')
  const image = (await library.capture('alice',data,'image/png'))!
  await library.capture('bob',data,'image/png')
  await library.revise('alice',image.id,{name:'测试表情',status:'ready'})
  assert.ok((await library.names('alice')).includes('测试表情'))
  await library.revise('alice',image.id,{name:'',status:'ready'})
  assert.equal((await library.catalog('alice'))[0]!.status,'pending')
  await library.revise('alice',image.id,{name:'测试表情',status:'ignored'})
  assert.ok(!(await library.names('alice')).includes('测试表情'))
  await library.publish('alice',image.id,'共享测试')
  assert.ok((await library.names('bob')).includes('共享测试'))
  assert.equal(await library.forget('alice',image.id),true)
  assert.equal(await library.locate('alice',image.id),undefined)
  assert.ok(await library.locate('bob',image.id))
  assert.equal(await library.unpublish('共享测试'),true)
  assert.ok(!(await library.names('bob')).includes('共享测试'))
})
