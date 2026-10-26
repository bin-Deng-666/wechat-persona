/**
 * 文件日志的测试：写入、按天分文件、按天数清理。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { createFileLogger } from '../../src/app/logger.ts'

const dirs: string[] = []
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }) })

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'persona-log-'))
  dirs.push(dir)
  return dir
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const started = Date.now()
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error('等待日志写入超时')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('createFileLogger', () => {
  it('把三档日志写进当天的文件', async () => {
    const dir = await makeDir()
    const logger = createFileLogger({ dir, now: () => new Date('2026-10-26T10:00:00') })
    logger.info('hello')
    logger.warn('warn-line')
    logger.error('error-line')
    await waitFor(async () => {
      try {
        const text = await readFile(join(dir, 'plugin-2026-10-26.log'), 'utf8')
        return text.includes('hello') && text.includes('warn-line') && text.includes('error-line')
      } catch {
        return false
      }
    })
    const text = await readFile(join(dir, 'plugin-2026-10-26.log'), 'utf8')
    assert.match(text, /INFO hello/)
    assert.match(text, /WARN warn-line/)
    assert.match(text, /ERROR error-line/)
  })

  it('按保留天数清理旧文件', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'plugin-2020-01-01.log'), 'old', 'utf8')
    const logger = createFileLogger({ dir, retentionDays: 7, now: () => new Date('2026-10-26T10:00:00') })
    logger.info('x')
    await waitFor(async () => !(await readdir(dir)).includes('plugin-2020-01-01.log'))
    assert.ok((await readdir(dir)).includes('plugin-2026-10-26.log'))
  })

  it('retentionDays 为 0 时不清理', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'plugin-2020-01-01.log'), 'old', 'utf8')
    const logger = createFileLogger({ dir, retentionDays: 0, now: () => new Date('2026-10-26T10:00:00') })
    logger.info('x')
    await waitFor(async () => (await readdir(dir)).includes('plugin-2026-10-26.log'))
    assert.ok((await readdir(dir)).includes('plugin-2020-01-01.log'))
  })
})
