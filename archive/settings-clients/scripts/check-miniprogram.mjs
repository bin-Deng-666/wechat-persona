import { readFile,readdir,access } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { Script } from 'node:vm'
const root=resolve('miniprogram'),app=JSON.parse(await readFile(join(root,'app.json'),'utf8'))
let checked=0
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())await walk(path);else if(entry.name.endsWith('.js')){new Script(await readFile(path,'utf8'),{filename:path});checked++}else if(entry.name.endsWith('.json'))JSON.parse(await readFile(path,'utf8'))}}
await walk(root)
for(const page of app.pages){await access(join(root,page+'.js'));await access(join(root,page+'.wxml'));const source=await readFile(join(root,page+'.wxml'),'utf8');const stack=[];for(const match of source.matchAll(/<\/?([\w-]+)(?:[^>"']|"[^"]*"|'[^']*')*>/g)){const text=match[0],name=match[1];if(text.startsWith('</')){if(stack.pop()!==name)throw new Error(page+' 的 '+name+' 标签没有正确闭合')}else if(!text.endsWith('/>'))stack.push(name)}if(stack.length)throw new Error(page+' 有未闭合标签')}
const project=JSON.parse(await readFile(join(root,'project.config.json'),'utf8')),config=await readFile(join(root,'config.js'),'utf8')
const ready=/^wx[a-f0-9]{16}$/.test(project.appid)&&/apiBase:\s*['"]https:\/\//.test(config)
if(process.argv.includes('--require-config')&&!ready)throw new Error('尚未配置正式小程序 AppID 与 HTTPS 服务域名')
console.log('小程序源码检查通过：'+app.pages.length+' 个页面、'+checked+' 个 JS 文件。')
console.log(ready?'已配置 AppID 与 HTTPS 地址，仍需微信开发者工具编译和真机验收。':'发布配置未完成：需要正式 AppID 与 HTTPS 服务域名。')
