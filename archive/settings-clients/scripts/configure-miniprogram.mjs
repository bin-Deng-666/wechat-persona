import { readFile,writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const args=process.argv.slice(2),get=flag=>args[args.indexOf(flag)+1]
const appid=get('--appid'),base=get('--api-base')
if(!/^wx[a-f0-9]{16}$/.test(appid||''))throw new Error('请提供正式 AppID：--appid wx...')
const url=new URL(base)
if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('--api-base 应为 HTTPS 域名，不含路径和凭据')
const file=resolve('miniprogram/project.config.json'),project=JSON.parse(await readFile(file,'utf8'));project.appid=appid
await writeFile(file,JSON.stringify(project,null,2)+'\n')
await writeFile(resolve('miniprogram/config.js'),'// 公共服务地址。此文件不包含密钥。\nmodule.exports = '+JSON.stringify({apiBase:url.origin},null,2)+'\n')
console.log('已配置小程序 AppID 与服务域名。请在微信平台同时添加 request 和 downloadFile 合法域名。')
