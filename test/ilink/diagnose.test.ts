/** 入站报文诊断：既能抓到未知字段，也不会把凭据写进日志。 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeInbound, needsDiagnosis, summarizeRaw } from '../../src/ilink/diagnose.ts'

const normal = {
  message_id: 'm1',
  from_user_id: 'u1',
  to_user_id: 'bot',
  message_type: 1,
  message_state: 2,
  context_token: 'secret-token',
  item_list: [{ type: 1, text_item: { text: '在吗' } }],
}

describe('describeInbound', () => {
  it('普通单聊报文只给出形状，且不暴露 context_token 的值', () => {
    const shape = describeInbound(normal)
    assert.ok(shape)
    assert.equal(shape.fromId, 'u1')
    assert.equal(shape.toId, 'bot')
    assert.equal(shape.messageType, 1)
    assert.equal(shape.hasContextToken, true)
    assert.deepEqual(shape.itemTypes, [1])
    assert.deepEqual(shape.unknown, [])
    assert.deepEqual(shape.unknownItems, [])
    assert.doesNotMatch(JSON.stringify(shape), /secret-token/)
  })

  it('顶层和消息项里的未知字段都会被点出来', () => {
    const shape = describeInbound({ ...normal, room_id: 'r1', item_list: [{ type: 1, text_item: {}, at_users: ['u2'] }] })
    assert.ok(shape)
    assert.deepEqual(shape.unknown, ['room_id'])
    assert.deepEqual(shape.unknownItems, ['at_users'])
  })

  it('读得出引用与 run_id，缺 from 时不猜', () => {
    const shape = describeInbound({ message_id: 'm2', run_id: 'r9', quote: { message_id: 'm1' }, item_list: [] })
    assert.ok(shape)
    assert.equal(shape.runId, 'r9')
    assert.equal(shape.quotedMessageId, 'm1')
    assert.equal(shape.fromId, undefined)
    assert.deepEqual(shape.itemTypes, [])
  })

  it('非对象返回 undefined，兜底摘要只记类型与字段名', () => {
    assert.equal(describeInbound('nope'), undefined)
    assert.equal(describeInbound(null), undefined)
    assert.equal(summarizeRaw('nope'), 'type=string')
    assert.equal(summarizeRaw({ a: 1, b: 2 }), 'type=object keys=a,b')
  })
})

describe('needsDiagnosis', () => {
  it('正常单聊不记录，缺 from、未知字段或开启详细诊断时才记录', () => {
    const normalShape = describeInbound(normal)!
    assert.equal(needsDiagnosis(normalShape, false), false)
    assert.equal(needsDiagnosis(normalShape, true), true)
    assert.equal(needsDiagnosis(describeInbound({ message_id: 'x' })!, false), true)
    assert.equal(needsDiagnosis(describeInbound({ ...normal, room_id: 'r1' })!, false), true)
  })
})
