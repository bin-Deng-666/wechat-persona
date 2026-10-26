/**
 * 媒体降级逻辑的测试：假附件存储、假下载器。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createMediaPreparer } from '../src/bridge/media.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function fakeStore() {
  const images: unknown[] = []
  const files: unknown[] = []
  return {
    store: {
      saveImages: async (inputs: readonly { data: Uint8Array; mediaType: string }[]) => {
        const ref = { kind: 'image-ref', mediaType: inputs[0]?.mediaType, size: inputs[0]?.data.length }
        images.push(ref)
        return [ref]
      },
      saveFile: async (input: { data: Uint8Array; name?: string }) => {
        const ref = { kind: 'file-ref', name: input.name, size: input.data.length }
        files.push(ref)
        return ref
      },
    },
    images,
    files,
  }
}

const imageItem = (overrides: Record<string, unknown> = {}) => ({
  type: 2,
  image_item: { media: { encrypt_query_param: 'q' }, ...overrides },
})

describe('createMediaPreparer', () => {
  it('没有媒体时返回空', async () => {
    const prepare = createMediaPreparer({})
    assert.deepEqual(await prepare([{ type: 1, text_item: { text: 'hi' } }]), { parts: [], notes: [] })
  })

  it('图片存进附件服务并产出 image 块', async () => {
    const { store, images } = fakeStore()
    const prepare = createMediaPreparer({ store: store as never, download: async () => PNG, supportsImage: async () => true })
    const result = await prepare([imageItem()])
    assert.equal(result.notes.length, 0)
    assert.deepEqual(result.parts, [{ type: 'image', attachment: images[0] }])
  })

  it('模型不支持看图时降级成说明，不产出块', async () => {
    const { store } = fakeStore()
    const prepare = createMediaPreparer({ store: store as never, download: async () => PNG, supportsImage: async () => false })
    const result = await prepare([imageItem()])
    assert.deepEqual(result.parts, [])
    assert.match(result.notes[0] ?? '', /不支持看图/)
  })

  it('宿主管不到附件服务时只说一句', async () => {
    const prepare = createMediaPreparer({ download: async () => PNG })
    const result = await prepare([imageItem()])
    assert.deepEqual(result.parts, [])
    assert.match(result.notes[0] ?? '', /没有附件服务/)
  })

  it('下载失败降级成说明而不是丢消息', async () => {
    const { store } = fakeStore()
    const reported: string[] = []
    const prepare = createMediaPreparer({
      store: store as never,
      download: async () => { throw new Error('404') },
      supportsImage: async () => true,
      report: line => reported.push(line),
    })
    const result = await prepare([imageItem()])
    assert.deepEqual(result.parts, [])
    assert.match(result.notes[0] ?? '', /没能读取/)
    assert.ok(reported.some(line => line.includes('图片处理失败')))
  })

  it('认不出格式的图片降级', async () => {
    const { store } = fakeStore()
    const prepare = createMediaPreparer({
      store: store as never,
      download: async () => Buffer.from('%PDF-1.7'),
      supportsImage: async () => true,
    })
    const result = await prepare([imageItem()])
    assert.match(result.notes[0] ?? '', /无法识别格式/)
  })

  it('文件存成 file 块并保留名字', async () => {
    const { store, files } = fakeStore()
    const prepare = createMediaPreparer({ store: store as never, download: async () => Buffer.from('data') })
    const result = await prepare([{ type: 4, file_item: { file_name: '报表.xlsx', media: { encrypt_query_param: 'f' } } }])
    assert.equal(result.parts.length, 1)
    assert.equal((files[0] as { name?: string }).name, '报表.xlsx')
  })

  it('语音/视频只留说明', async () => {
    const { store } = fakeStore()
    const prepare = createMediaPreparer({ store: store as never, download: async () => Buffer.from('x') })
    const result = await prepare([{ type: 3, voice_item: { media: { encrypt_query_param: 'v' } } }])
    assert.deepEqual(result.parts, [])
    assert.match(result.notes[0] ?? '', /语音/)
  })
})
