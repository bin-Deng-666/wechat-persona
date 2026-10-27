/** 本机多进程文件事务。锁随活进程持有，异常退出后由下一位写入者回收。 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { SerialWork } from './atomic.ts'

const queues = new Map<string, SerialWork>()
function alive(pid: number): boolean {
  try { process.kill(pid,0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}
async function reclaim(lock: string): Promise<void> {
  // 活锁的等待者只读 owner，不创建文件，避免与持有者的释放操作竞争。
  try {
    const owner = JSON.parse(await readFile(join(lock,'owner.json'),'utf8')) as {pid:number}
    if (alive(owner.pid)) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
    try { if (Date.now() - (await stat(lock)).mtimeMs < 10000) return } catch { return }
  }
  const recovery = join(lock,'recovery')
  try { await mkdir(recovery) } catch { return }
  let moved = false
  try {
    let abandoned = false
    try {
      const owner = JSON.parse(await readFile(join(lock,'owner.json'),'utf8')) as {pid:number}
      abandoned = typeof owner.pid === 'number' && !alive(owner.pid)
    } catch {
      abandoned = Date.now() - (await stat(lock)).mtimeMs > 10000
    }
    if (abandoned) {
      const stale = `${lock}.${randomUUID()}.stale`
      await rename(lock,stale); moved = true
      await rm(stale,{recursive:true,force:true})
    }
  } finally { if (!moved) await rm(recovery,{recursive:true,force:true}).catch(() => {}) }
}
export async function withFileLock<T>(file: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let queue = queues.get(file)
  if (!queue) { queue = new SerialWork(); queues.set(file,queue) }
  return await queue.run(async () => {
    const lock = `${file}.lock`, token = randomUUID(), deadline = Date.now() + 15000
    await mkdir(dirname(file),{recursive:true,mode:0o700})
    for (;;) {
      signal?.throwIfAborted()
      try {
        await mkdir(lock,{mode:0o700})
        try { await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.pid,token}),{mode:0o600,flag:'wx'}) }
        catch (error) { await rm(lock,{recursive:true,force:true}); throw error }
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await reclaim(lock)
        if (Date.now() >= deadline) throw new Error('数据正在被其他进程修改，请稍后重试')
        await delay(25,undefined,{signal})
      }
    }
    try { signal?.throwIfAborted(); return await work() }
    finally {
      const owner = JSON.parse(await readFile(join(lock,'owner.json'),'utf8')) as {token:string}
      if (owner.token !== token) throw new Error('文件事务锁已变化；保留数据供检查')
      const released = `${lock}.${token}.released`
      await rename(lock,released)
      await rm(released,{recursive:true,force:true})
    }
  })
}
