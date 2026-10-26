/**
 * 主动搭话判定的测试：免打扰、跨零点、空闲阈值。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isQuietNow, minutesOfDay, proactiveInstruction, shouldPoke } from '../src/channel/proactive.ts'

describe('minutesOfDay', () => {
  it('解析合法时间', () => {
    assert.equal(minutesOfDay('00:00'), 0)
    assert.equal(minutesOfDay('08:30'), 510)
    assert.equal(minutesOfDay('23:59'), 1439)
  })

  it('拒绝非法时间', () => {
    assert.equal(minutesOfDay('24:00'), undefined)
    assert.equal(minutesOfDay('9:00'), undefined)
    assert.equal(minutesOfDay('abc'), undefined)
  })
})

describe('isQuietNow', () => {
  it('普通区间', () => {
    assert.equal(isQuietNow(9 * 60, ['08:00', '18:00']), true)
    assert.equal(isQuietNow(19 * 60, ['08:00', '18:00']), false)
  })

  it('跨零点区间', () => {
    assert.equal(isQuietNow(23 * 60, ['22:00', '08:00']), true)
    assert.equal(isQuietNow(3 * 60, ['22:00', '08:00']), true)
    assert.equal(isQuietNow(12 * 60, ['22:00', '08:00']), false)
  })

  it('起止相同视为全天', () => {
    assert.equal(isQuietNow(12 * 60, ['08:00', '08:00']), true)
  })

  it('非法格式不静默变成静音', () => {
    assert.equal(isQuietNow(12 * 60, ['99:99', '08:00']), false)
  })
})

describe('shouldPoke', () => {
  const now = Date.parse('2026-10-26T14:00:00+08:00')
  const base = {
    now,
    lastSeenAt: now - 7 * 60 * 60 * 1_000,
    minIdleHours: 6,
    quietHours: ['23:00', '08:00'] as const,
    enabled: true,
    timezoneOffsetMinutes: 8 * 60,
  }

  it('满足条件时为 true', () => {
    assert.equal(shouldPoke(base), true)
  })

  it('关闭时不主动', () => {
    assert.equal(shouldPoke({ ...base, enabled: false }), false)
  })

  it('没安静够不说', () => {
    assert.equal(shouldPoke({ ...base, lastSeenAt: now - 60 * 60 * 1_000 }), false)
  })

  it('免打扰时段内不说', () => {
    assert.equal(shouldPoke({ ...base, now: Date.parse('2026-10-26T23:30:00+08:00') }), false)
  })

  it('从未说过话时不主动', () => {
    assert.equal(shouldPoke({ ...base, lastSeenAt: undefined }), false)
  })

  it('指令里明确要求别提提示本身', () => {
    assert.match(proactiveInstruction(), /不要提到这条提示/)
  })
})
