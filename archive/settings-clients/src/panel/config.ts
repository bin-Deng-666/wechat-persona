/** 固定入口与常驻服务配置，保存在运行数据目录，不进入仓库。 */
import { hostname, networkInterfaces } from 'node:os'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicJson } from '../../../../src/storage/atomic.ts'
import { PUBLIC_PATH } from './routes.ts'

export const SETTINGS_PORT = 32741
export interface SettingsConfig { version:1; host:string; port:number; publicUrl?:string; localName?:string }
export const settingsDir = (dataDir: string) => join(dataDir,'settings')
export const controlSocket = (dataDir: string) => join(settingsDir(dataDir),'control.sock')
export const hostSocket = (dataDir: string) => join(settingsDir(dataDir),'host.sock')

export function validatePublicUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('远程入口应为不带路径和凭据的 HTTPS 域名，例如 https://settings.example.com')
  return url.origin
}
export async function loadSettingsConfig(dataDir: string): Promise<SettingsConfig> {
  try {
    const config = JSON.parse(await readFile(join(settingsDir(dataDir),'service.json'),'utf8')) as SettingsConfig
    if (config.version !== 1 || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535 || !['127.0.0.1','0.0.0.0'].includes(config.host)) throw new Error('设置服务配置无效')
    if (config.publicUrl) config.publicUrl = validatePublicUrl(config.publicUrl)
    if (config.localName && !/^[a-zA-Z0-9-]+\.local$/u.test(config.localName)) throw new Error('本机名称不合法')
    return config
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return {version:1,host:'0.0.0.0',port:SETTINGS_PORT}
  }
}
export async function saveSettingsConfig(dataDir: string,config: SettingsConfig): Promise<void> {
  if (config.publicUrl) validatePublicUrl(config.publicUrl)
  await atomicJson(join(settingsDir(dataDir),'service.json'),config)
}
export function lanAddress(interfaces = networkInterfaces()): string {
  const entries = Object.entries(interfaces).sort(([a],[b]) => Number(!/^(en|eth|wlan)/u.test(a)) - Number(!/^(en|eth|wlan)/u.test(b)))
  for (const [name,addresses] of entries) {
    if (/^(lo|utun|tun|tap|bridge|docker|veth)/u.test(name)) continue
    const address = addresses?.find(item => item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.'))
    if (address) return address.address
  }
  return '127.0.0.1'
}
export function localOrigin(config: SettingsConfig): string { return `http://127.0.0.1:${config.port}` }
export interface EntryAddresses { primary:string; alternates:string[]; scope:'public'|'lan'|'local' }
/**
 * 手机与浏览器的入口地址。
 *
 * 优先级：已配置的公网 HTTPS 域名 → 局域网 IP（iOS 与 Android 都能解析）→ 电脑本机。
 * `.local` 只作为备选：iPhone 能解析它，部分 Android 不能，当主地址会让人以为服务坏了。
 */
export function entryAddresses(config: SettingsConfig): EntryAddresses {
  if (config.publicUrl) return { primary:config.publicUrl,alternates:[],scope:'public' }
  if (config.host === '127.0.0.1') return { primary:`http://127.0.0.1:${config.port}`,alternates:[],scope:'local' }
  const local = config.localName || (hostname().endsWith('.local') ? hostname() : '')
  return { primary:`http://${lanAddress()}:${config.port}`,alternates:local ? [`http://${local}:${config.port}`] : [],scope:'lan' }
}
export function browserOrigin(config: SettingsConfig): string { return entryAddresses(config).primary }
export const settingsUrl = (config: SettingsConfig) => entryAddresses(config).primary + PUBLIC_PATH
