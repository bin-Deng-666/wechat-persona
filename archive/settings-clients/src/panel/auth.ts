/** 一次配对，长期使用。浏览器只保存 HttpOnly cookie，磁盘只保存其摘要。 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { atomicJson } from '../../../../src/storage/atomic.ts'
import { withFileLock } from '../../../../src/storage/lock.ts'
import type { PanelGrant } from './http.ts'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export const SESSION_COOKIE = 'wechat_settings_session'
export const SESSION_SECONDS = 90 * 24 * 60 * 60
interface DeviceSession { id:string; secretHash:string; grant:PanelGrant; label:string; createdAt:number; lastSeenAt:number; expiresAt:number }
interface AuthState { version:1; sessions:DeviceSession[] }
interface Pairing { tokenHash:string; codeHash:string; grant:PanelGrant; expiresAt:number }
export interface AuthenticatedDevice { id:string; grant:PanelGrant }
export function validateGrant(value: unknown): PanelGrant {
  const grant = value as PanelGrant | null
  if (!grant || typeof grant.admin !== 'boolean' || (!grant.admin && !grant.peerId)) throw new Error('登录权限不合法')
  if (grant.peerId !== undefined && (typeof grant.peerId !== 'string' || !grant.peerId || grant.peerId.length > 256 || /[\u0000-\u001f]/u.test(grant.peerId))) throw new Error('联系人不合法')
  return {admin:grant.admin,...(grant.peerId ? {peerId:grant.peerId} : {})}
}
export class DeviceAuth {
  private readonly file: string
  private readonly now: () => number
  private readonly pairings = new Map<string,Pairing>()
  constructor(file: string,now: () => number = Date.now) { this.file = file; this.now = now }
  private async read(): Promise<AuthState> {
    try {
      const state = JSON.parse(await readFile(this.file,'utf8')) as AuthState
      if (state.version !== 1 || !Array.isArray(state.sessions) || state.sessions.some(s => typeof s.secretHash !== 'string' || typeof s.expiresAt !== 'number')) throw new Error('登录状态文件格式错误')
      return state
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return {version:1,sessions:[]} }
  }
  issue(grant: PanelGrant): {token:string;code:string;expiresAt:number} {
    for (const [id,pair] of this.pairings) if (pair.expiresAt <= this.now()) this.pairings.delete(id)
    if (this.pairings.size >= 100) throw new Error('登录请求过多，请稍后重试')
    const token = randomBytes(24).toString('base64url')
    let code: string
    do { code = String(randomInt(10000000,100000000)) } while ([...this.pairings.values()].some(pair => pair.codeHash === digest(code)))
    const expiresAt = this.now() + 10 * 60000
    this.pairings.set(digest(token),{tokenHash:digest(token),codeHash:digest(code),grant:validateGrant(grant),expiresAt})
    return {token,code,expiresAt}
  }
  async exchange(value: string,userAgent: string): Promise<{cookie:string;device:AuthenticatedDevice}> {
    const key = digest(value.trim()), pair = [...this.pairings.values()].find(p => p.tokenHash === key || p.codeHash === key)
    if (!pair || pair.expiresAt <= this.now()) throw new Error('验证码已失效，请重新获取')
    // 在首次 await 前消费，两个同时到达的请求不能交换同一张票。
    this.pairings.delete(pair.tokenHash)
    const id = randomUUID(), secret = randomBytes(32).toString('base64url'), now = this.now()
    await withFileLock(this.file,async () => {
      const state = await this.read()
      state.sessions = state.sessions.filter(session => session.expiresAt > now)
      state.sessions.push({id,secretHash:digest(secret),grant:pair.grant,label:this.deviceLabel(userAgent),createdAt:now,lastSeenAt:now,expiresAt:now + SESSION_SECONDS * 1000})
      if (state.sessions.length > 100) state.sessions = state.sessions.slice(-100)
      await atomicJson(this.file,state)
    })
    return {cookie:`${id}.${secret}`,device:{id,grant:pair.grant}}
  }
  async authenticate(cookie: string): Promise<AuthenticatedDevice | undefined> {
    const value = cookie.startsWith('Bearer ') ? cookie.slice(7).trim() : cookie.split(';').map(item => item.trim()).find(item => item.startsWith(SESSION_COOKIE + '='))?.slice(SESSION_COOKIE.length + 1)
    if (!value) return undefined
    const separator = value.indexOf('.'), id = value.slice(0,separator), secret = value.slice(separator + 1)
    const session = (await this.read()).sessions.find(item => item.id === id && item.secretHash === digest(secret) && item.expiresAt > this.now())
    if (!session) return undefined
    if (this.now() - session.lastSeenAt > 60000) await withFileLock(this.file,async () => {
      const state = await this.read(), current = state.sessions.find(item => item.id === id)
      if (current) { current.lastSeenAt = this.now(); await atomicJson(this.file,state) }
    })
    return {id:session.id,grant:validateGrant(session.grant)}
  }
  async devices(device: AuthenticatedDevice) {
    return (await this.read()).sessions.filter(s => s.expiresAt > this.now() && (device.grant.admin || (!s.grant.admin && s.grant.peerId === device.grant.peerId))).map(s => ({id:s.id,label:s.label,createdAt:s.createdAt,lastSeenAt:s.lastSeenAt,current:s.id === device.id}))
  }
  async revoke(device: AuthenticatedDevice,id: string): Promise<void> {
    await withFileLock(this.file,async () => {
      const state = await this.read(), target = state.sessions.find(s => s.id === id)
      if (!target) return
      if (!device.grant.admin && (target.grant.admin || target.grant.peerId !== device.grant.peerId)) throw new Error('只能管理自己的登录设备')
      state.sessions = state.sessions.filter(s => s.id !== id)
      await atomicJson(this.file,state)
    })
  }
  cookie(value: string,secure: boolean,clear = false): string {
    return `${SESSION_COOKIE}=${value}; Path=/persona-wechat/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_SECONDS}${secure ? '; Secure' : ''}`
  }
  private deviceLabel(ua: string): string {
    const system = /iPhone|iPad/u.test(ua) ? 'iPhone / iPad' : /Android/u.test(ua) ? 'Android' : /Macintosh/u.test(ua) ? 'Mac' : /Windows/u.test(ua) ? 'Windows' : '浏览器'
    return system + (/MicroMessenger/u.test(ua) ? ' · 微信' : /Edg\//u.test(ua) ? ' · Edge' : /Chrome\//u.test(ua) ? ' · Chrome' : /Safari\//u.test(ua) ? ' · Safari' : '')
  }
}
