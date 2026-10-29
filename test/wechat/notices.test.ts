/** 报平安短句：取句器的不重复规则，以及人格卡缺失时的回退。 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_NOTICE_INTERVAL_MS, DEFAULT_NOTICE_WINDOW_MS } from '../../src/wechat/channel.ts'
import { BUILTIN_DEFAULT } from '../../src/persona/store.ts'
import {
  DEFAULT_NOTICES,
  MAX_NOTICE_CHARS,
  createNoticePicker,
  noticesFor,
} from '../../src/wechat/notices.ts'

/** 固定序列的伪随机源，让洗牌结果可复现。 */
function sequence(values: readonly number[]): () => number {
  let index = 0
  return () => values[index++ % values.length]!
}

describe('createNoticePicker', () => {
  it('一轮之内不重复，取完才重新洗牌', () => {
    const lines = ['甲', '乙', '丙', '丁']
    const next = createNoticePicker(lines, sequence([0.1, 0.7, 0.3, 0.9]))
    const first = [next(), next(), next(), next()]
    assert.equal(new Set(first).size, 4, JSON.stringify(first))
    // 第二轮重新洗牌，但仍然是这四条。
    const second = [next(), next(), next(), next()]
    assert.equal(new Set(second).size, 4)
    assert.deepEqual([...first].sort(), [...second].sort())
  })

  it('空池子始终返回空，不会发出空消息', () => {
    const next = createNoticePicker([])
    assert.equal(next(), undefined)
    assert.equal(next(), undefined)
  })

  it('空串与纯空白被丢掉，重复条目去重', () => {
    const next = createNoticePicker(['甲', '  ', '', '甲', ' 乙 '], sequence([0.5]))
    // 洗完只有两条：甲 与 乙（乙 的首尾空白被去掉）。取满一轮后重新洗牌。
    const round = [next(), next()]
    assert.deepEqual([...round].sort(), ['乙', '甲'].sort())
    assert.equal(new Set(round).size, 2)
  })

  it('内置库够多，且都短', () => {
    assert.ok(DEFAULT_NOTICES.length >= 20, String(DEFAULT_NOTICES.length))
    for (const line of DEFAULT_NOTICES) {
      assert.ok(Array.from(line).length <= MAX_NOTICE_CHARS, line)
    }
  })
})

describe('noticesFor', () => {
  it('人格卡写了就用卡里的', () => {
    assert.deepEqual(noticesFor({ progress: ['在弄'] }), ['在弄'])
  })

  it('人格卡没写、或为空数组时回退内置库', () => {
    assert.deepEqual(noticesFor({}), DEFAULT_NOTICES)
    assert.deepEqual(noticesFor({ progress: [] }), DEFAULT_NOTICES)
    assert.deepEqual(noticesFor(undefined), DEFAULT_NOTICES)
  })
})

describe('默认节奏与文案条数的耦合', () => {
  /**
   * 一轮配额 = ceil(窗口 / 间隔)。这个数**必须**不超过人格卡要求的最小条数，
   * 否则一轮之内就会开始重样——上一版被否掉的原因正是重复。
   */
  it('默认节奏下的一轮配额正好等于最小文案条数', () => {
    const quota = Math.ceil(DEFAULT_NOTICE_WINDOW_MS / DEFAULT_NOTICE_INTERVAL_MS)
    // 10 条是 `persona/card.ts` 的 MIN_PROGRESS_LINES；内置卡也得写满这个数。
    assert.equal(quota, 10, `配额 ${String(quota)} 条`)
    assert.equal(BUILTIN_DEFAULT.progress.length, quota, '内置卡条数与配额对不上')
    assert.equal(new Set(BUILTIN_DEFAULT.progress).size, quota, '内置卡有重复句')
    for (const line of BUILTIN_DEFAULT.progress) {
      assert.ok(Array.from(line).length <= MAX_NOTICE_CHARS, line)
    }
  })

  it('内置卡不写身体，也不承诺时间', () => {
    const banned = ['身体', '手', '脚', '头', '眼睛', '耳朵', '尾巴', '马上', '立刻', '几秒', '分钟']
    for (const line of BUILTIN_DEFAULT.progress) {
      for (const word of banned) assert.ok(!line.includes(word), `「${line}」含「${word}」`)
    }
  })
})
