#!/usr/bin/env node
/** 独立设置服务命令行与 macOS LaunchAgent 安装。 */
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { startSettingsService } from './service.ts'
import { browserOrigin, controlSocket, loadSettingsConfig, saveSettingsConfig, settingsDir, settingsUrl } from './config.ts'
import { rpcCall } from './rpc.ts'

const label = 'com.wechat-persona.settings'
const xml = (value: string) => value.replace(/[&<>"']/gu,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!))
const argv = process.argv.slice(2), command = argv[0] || 'help'
const flag = (name: string) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined }
const dataDir = resolve(flag('--data-dir') || join(homedir(),'.dsh','wechat-persona'))
const agentFile = join(homedir(),'Library','LaunchAgents',label + '.plist')

async function configure() {
  const config = await loadSettingsConfig(dataDir)
  const port = flag('--port'), host = flag('--bind'), publicUrl = flag('--public-url')
  if (port !== undefined) { const number = Number(port); if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('端口应为 1–65535'); config.port = number }
  if (host !== undefined) { if (!['127.0.0.1','0.0.0.0'].includes(host)) throw new Error('监听地址应为 127.0.0.1 或 0.0.0.0'); config.host = host }
  if (publicUrl !== undefined) { if (publicUrl === '') delete config.publicUrl; else config.publicUrl = publicUrl }
  if (process.platform === 'darwin' && !config.localName) {
    const local = spawnSync('/usr/sbin/scutil',['--get','LocalHostName'],{encoding:'utf8'})
    const name = local.stdout.trim()
    if (/^[a-zA-Z0-9-]+$/u.test(name)) config.localName = name + '.local'
  }
  await saveSettingsConfig(dataDir,config)
  return config
}
async function install() {
  if (process.platform !== 'darwin') throw new Error('自动安装目前支持 macOS；其他系统可用 serve 配合进程管理器')
  const config = await configure(), runtime = join(settingsDir(dataDir),'runtime')
  await mkdir(runtime,{recursive:true,mode:0o700}); await mkdir(join(settingsDir(dataDir),'logs'),{recursive:true,mode:0o700})
  const source = dirname(fileURLToPath(import.meta.url)), target = join(runtime,'lib')
  if (resolve(source) !== resolve(target)) await cp(source,target,{recursive:true})
  await writeFile(join(runtime,'package.json'),JSON.stringify({private:true,type:'module'}),{mode:0o600})
  const args = [process.execPath,join(target,'settings.js'),'serve','--data-dir',dataDir]
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string><key>StandardOutPath</key><string>${xml(join(settingsDir(dataDir),'logs','service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(settingsDir(dataDir),'logs','error.log'))}</string></dict></plist>\n`
  await mkdir(dirname(agentFile),{recursive:true})
  spawnSync('/bin/launchctl',['bootout',`gui/${process.getuid!()}/${label}`],{encoding:'utf8'})
  await writeFile(agentFile,plist,{mode:0o600})
  const result = spawnSync('/bin/launchctl',['bootstrap',`gui/${process.getuid!()}`,agentFile],{encoding:'utf8'})
  if (result.status !== 0) throw new Error('后台服务安装失败：' + result.stderr.trim())
  const shortcut = flag('--shortcut')
  if (shortcut) await writeFile(resolve(shortcut),`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>URL</key><string>${xml(settingsUrl(config))}</string></dict></plist>\n`,{mode:0o600})
  console.log('设置服务已安装，会在登录电脑后自动启动。')
  console.log('固定入口：' + settingsUrl(config))
  if (!config.publicUrl) console.log('当前入口限本机或同一网络；公网 HTTPS 域名尚未配置。')
}
async function main() {
  if (command === 'serve') {
    const service = await startSettingsService(dataDir)
    console.log('设置服务已启动：' + settingsUrl(await loadSettingsConfig(dataDir)))
    let closing = false
    const close = () => { if (closing) return; closing = true; void service.close().finally(() => process.exit(0)) }
    process.on('SIGINT',close); process.on('SIGTERM',close)
    return
  }
  if (command === 'install') { await install(); return }
  if (command === 'configure') { console.log('已保存：' + settingsUrl(await configure())); console.log('请重启设置服务使配置生效。'); return }
  if (command === 'url') { console.log(settingsUrl(await loadSettingsConfig(dataDir))); return }
  if (command === 'open' || command === 'pair') {
    const pair = await rpcCall<{url:string;code:string;expiresAt:number;address:string}>(controlSocket(dataDir),'pair',{admin:true})
    if (argv.includes('--json')) { console.log(JSON.stringify(pair)); return }
    console.log('固定入口：' + pair.address); console.log('一次性登录码（10 分钟有效）：' + pair.code)
    if (command === 'open') {
      if (process.platform !== 'darwin') console.log('一次性登录链接：' + pair.url)
      else spawnSync('/usr/bin/open',[pair.url])
    }
    return
  }
  if (command === 'uninstall') {
    if (process.platform !== 'darwin') throw new Error('请使用系统进程管理器停止 serve')
    const result = spawnSync('/bin/launchctl',['bootout',`gui/${process.getuid!()}/${label}`],{encoding:'utf8'})
    if (result.status !== 0) throw new Error(result.stderr.trim() || '服务未安装')
    console.log('后台服务已停止。设置与登录设备数据已保留。'); return
  }
  console.log('设置服务\n\nserve       独立运行\ninstall     安装 macOS 登录后台服务\nopen        登录并打开固定入口\npair        生成一次性绑定码\nurl         查看固定入口\nconfigure   设置端口或 HTTPS 公网域名\nuninstall   停止后台服务\n\n选项：--data-dir <目录> --port <端口> --bind 127.0.0.1|0.0.0.0 --public-url https://域名 --shortcut <桌面.webloc>')
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
