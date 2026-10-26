/**
 * 登录凭据的本地持久化。
 *
 * 放自己的数据目录（`<dataDir>/account.json`），权限 0600，不进 profile 的 yaml：
 * 这个 token 等价于「这个微信 bot 的身份」，泄露等于别人能用你的 bot 发言。
 *
 * 与 DSH 的 credentials 服务解耦是有意的：那套服务的记录形状随宿主演进，
 * 而我们只要「一个 token + 一个 base url」；用文件也便于用户直接删号。
 *
 * @module wechat-persona/credentials
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface StoredAccount {
  /** `ilink_bot_id`。 */
  accountId: string
  /** 扫码登录的那个微信号。 */
  userId?: string
  baseUrl: string
  botToken: string
  /** 写入时间，ISO 字符串；用于诊断「是不是很久没重新登录」。 */
  savedAt: string
}

/**
 * 读账号。
 * @param dataDir - 插件数据目录。
 * @returns 账号，或 undefined（没登录过/文件坏了）。
 */
export async function loadAccount(dataDir: string): Promise<StoredAccount | undefined> {
  try {
    const raw = await readFile(join(dataDir, 'account.json'), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredAccount>
    if (typeof parsed.botToken !== 'string' || parsed.botToken === '') return undefined
    if (typeof parsed.baseUrl !== 'string' || parsed.baseUrl === '') return undefined
    if (typeof parsed.accountId !== 'string' || parsed.accountId === '') return undefined
    return {
      accountId: parsed.accountId,
      baseUrl: parsed.baseUrl,
      botToken: parsed.botToken,
      ...(typeof parsed.userId === 'string' ? { userId: parsed.userId } : {}),
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date(0).toISOString(),
    }
  } catch {
    return undefined
  }
}

/**
 * 写账号：先写临时文件再 rename，避免写到一半崩溃留下半个 JSON。
 * @param dataDir - 插件数据目录。
 * @param account - 要保存的账号。
 */
export async function saveAccount(dataDir: string, account: Omit<StoredAccount, 'savedAt'>): Promise<StoredAccount> {
  const stored: StoredAccount = { ...account, savedAt: new Date().toISOString() }
  const target = join(dataDir, 'account.json')
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const temp = `${target}.${String(process.pid)}.tmp`
  await writeFile(temp, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temp, target)
  // rename 会保留临时文件的权限，但显式 chmod 一次，防某些文件系统忽略 mode。
  await chmod(target, 0o600).catch(() => {})
  return stored
}

/**
 * 删账号（退出登录）。
 * @param dataDir - 插件数据目录。
 */
export async function forgetAccount(dataDir: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(join(dataDir, 'account.json'), { force: true })
}
