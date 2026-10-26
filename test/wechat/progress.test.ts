/** 进度提示：优先用模型自己的旁白，其次按工具，宁可不发也不再写一句固定台词。 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { progressLine } from '../../src/wechat/progress.ts'

describe('progressLine', () => {
  it('有旁白就用模型的原话', () => {
    assert.equal(progressLine({ narration: '我先看一下日志', toolName: 'bash' }), '我先看一下日志')
  })

  it('旁白过长时截断，不整段刷屏', () => {
    const line = progressLine({ narration: 'x'.repeat(200) })
    assert.equal(line?.length, 81)
    assert.ok(line?.endsWith('…'))
  })

  it('没有旁白时按工具说一句', () => {
    assert.equal(progressLine({ toolName: 'bash' }), '还在跑命令，稍等一下。')
    assert.match(progressLine({ toolName: 'unknown-tool' }) ?? '', /unknown-tool/)
  })

  it('既没旁白也没工具就不发——避免又变成固定说辞', () => {
    assert.equal(progressLine(undefined), undefined)
    assert.equal(progressLine({}), undefined)
    assert.equal(progressLine({ narration: '   ' }), undefined)
  })
})
