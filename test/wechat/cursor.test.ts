/**
 * 游标落盘判据的测试：只在真正前进时写。
 *
 * 这一条来自真实故障：长轮询每几秒返回一次，`get_updates_buf` 常常原样返回，
 * 而实现拿「启动时的基线」比较，于是每 5 秒都把同一个值重写一遍。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { shouldPersistCursor } from '../../src/wechat/cursor.ts'

describe('shouldPersistCursor', () => {
  it('通道还没拿到游标时不写', () => {
    assert.equal(shouldPersistCursor(undefined, undefined), false)
    assert.equal(shouldPersistCursor('cursor-1', undefined), false)
  })

  it('值没变时不写', () => {
    assert.equal(shouldPersistCursor('cursor-1', 'cursor-1'), false)
  })

  it('值前进时写', () => {
    assert.equal(shouldPersistCursor('cursor-1', 'cursor-2'), true)
  })

  it('首次落盘（此前没有值）时写', () => {
    assert.equal(shouldPersistCursor(undefined, 'cursor-1'), true)
  })

  it('连续轮询返回同一个值时只写一次', () => {
    // 模拟长轮询：同一个 buf 连着返回四次。
    let persisted: string | undefined
    const writes: string[] = []
    for (const current of ['cursor-1', 'cursor-1', 'cursor-1', 'cursor-1']) {
      if (shouldPersistCursor(persisted, current)) {
        persisted = current
        writes.push(current)
      }
    }
    assert.deepEqual(writes, ['cursor-1'])
  })
})
