/**
 * 插件自己的诊断日志。
 *
 * 宿主日志会滚、会被 GUI 的日志面板淹没，而「到底加载了没有、轮询到哪一步」这类问题
 * 需要在用户的机器上直接看文件。所以这里写一份自己的、按天分文件、按天数保留的日志。
 *
 * 写入失败永远不抛：日志是观测手段，不能成为故障源。
 *
 * @module wechat-persona/channel/log-file
 */

import { appendFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

export interface FileLogger {
  info: (line: string) => void
  warn: (line: string) => void
  error: (line: string) => void
  /** 当前日志文件路径，供面板/诊断显示。 */
  path: () => string
}

export interface FileLoggerOptions {
  /** 日志目录。 */
  dir: string
  /** 保留天数；0 表示不清理。 */
  retentionDays?: number
  /** 时钟，测试用。 */
  now?: () => Date
}

function dayStamp(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(year)}-${month}-${day}`
}

/**
 * 造一个文件日志器。
 *
 * @param options - 目录、保留天数。
 * @returns 日志器；第一次写时创建目录，并顺手清理过期文件。
 */
export function createFileLogger(options: FileLoggerOptions): FileLogger {
  const clock = options.now ?? (() => new Date())
  let ready: Promise<void> | undefined
  let file = join(options.dir, `plugin-${dayStamp(clock())}.log`)

  const fileFor = (date: Date): string => join(options.dir, `plugin-${dayStamp(date)}.log`)

  async function prepare(): Promise<void> {
    await mkdir(options.dir, { recursive: true, mode: 0o700 })
    await prune()
  }

  async function prune(): Promise<void> {
    const days = options.retentionDays ?? 7
    if (days <= 0) return
    try {
      const cutoff = clock().getTime() - days * 24 * 60 * 60 * 1_000
      for (const name of await readdir(options.dir)) {
        const match = /^plugin-(\d{4})-(\d{2})-(\d{2})\.log$/u.exec(name)
        if (match === null) continue
        const stamp = Date.parse(`${String(match[1])}-${String(match[2])}-${String(match[3])}T00:00:00`)
        if (Number.isFinite(stamp) && stamp < cutoff) await rm(join(options.dir, name), { force: true })
      }
    } catch {
      // 清理失败不影响写日志。
    }
  }

  function write(level: 'INFO' | 'WARN' | 'ERROR', line: string): void {
    // 日期翻篇时切文件。
    file = fileFor(clock())
    const entry = `${clock().toISOString()} ${level} ${line}\n`
    ready ??= prepare()
    void ready
      .then(async () => { await appendFile(file, entry, { encoding: 'utf8', mode: 0o600 }) })
      .catch(() => {})
  }

  return {
    info: line => { write('INFO', line) },
    warn: line => { write('WARN', line) },
    error: line => { write('ERROR', line) },
    path: () => file,
  }
}
