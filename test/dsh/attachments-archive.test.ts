import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMediaPreparer } from '../../src/dsh/attachments.ts'

describe('没有附件服务时的旁路', () => {
  it('仍然把图片交给 onImage（收表情不依赖看图能力）', async () => {
    const seen: string[] = []
    const preparer = createMediaPreparer({
      download: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      onImage: ({ mediaType, peerId }) => { seen.push(`${mediaType}:${peerId ?? ''}`) },
      report: () => {},
    })
    const prepared = await preparer([{ type: 2, image_item: { media: { encrypt_query_param: 'q' } } }] as never, 'wxid-a')
    assert.deepEqual(seen, ['image/png:wxid-a'])
    assert.equal(prepared.parts.length, 0)
    assert.ok(prepared.notes.length > 0)
  })
})
