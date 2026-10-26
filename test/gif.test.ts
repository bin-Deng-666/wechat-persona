/** GIF 多帧视觉输入与原件保留路径。 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PNG } from 'pngjs'
import { previewGif } from '../src/bridge/gif.ts'
import { createMediaPreparer } from '../src/bridge/media.ts'

/** 1x1 两色 GIF：每个帧用固定的 clear/pixel/end LZW 代码。 */
function gif(frames: { color: 0 | 1; disposal?: number; transparent?: boolean }[]) {
  const bytes = [...Buffer.from('GIF89a'), 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]
  for (const frame of frames) bytes.push(
    0x21, 0xf9, 4, ((frame.disposal ?? 0) << 2) | (frame.transparent ? 1 : 0), 1, 0, 0, 0,
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, frame.color === 0 ? 0x44 : 0x4c, 1, 0,
  )
  bytes.push(0x3b)
  return Buffer.from(bytes)
}

describe('GIF 预览', () => {
  it('动画的不同帧转成 PNG，不只看到首帧', () => {
    const frames = previewGif(gif([{ color: 0 }, { color: 1 }]))
    assert.equal(frames.length, 2)
    assert.deepEqual([...PNG.sync.read(Buffer.from(frames[0]!)).data], [0, 0, 0, 255])
    assert.deepEqual([...PNG.sync.read(Buffer.from(frames[1]!)).data], [255, 255, 255, 255])
  })
  it('恢复前画面的 disposal=3 得到正确后续帧', () => {
    const frames = previewGif(gif([{ color: 0 }, { color: 1, disposal: 3 }, { color: 0, transparent: true }]))
    assert.equal(frames.length, 3)
    assert.deepEqual([...PNG.sync.read(Buffer.from(frames[2]!)).data], [0, 0, 0, 255])
  })
  it('超过画布预算时拒绝解码', () => {
    const image = gif([{ color: 0 }])
    image.writeUInt16LE(65535, 6)
    image.writeUInt16LE(65535, 8)
    assert.throws(() => previewGif(image), /解码上限/)
  })
  it('媒体处理收藏原始 GIF，视觉输入为 PNG 帧，无虚构用户文字', async () => {
    const original = gif([{ color: 0 }, { color: 1 }])
    const archived: Uint8Array[] = []
    const saved: { data: Uint8Array; mediaType: string }[] = []
    const prepare = createMediaPreparer({
      download: async () => original,
      supportsImage: async () => true,
      onImage: async ({ data, peerId }) => { assert.equal(peerId, 'u1'); archived.push(data); return 's_test' },
      store: {
        saveImages: async inputs => { saved.push(...inputs); return inputs.map((_, index) => ({ id: String(index) })) },
        saveFile: async () => { throw new Error('不应作为普通文件') },
      },
    })
    const result = await prepare([{ type: 2, image_item: { media: { full_url: 'https://cdn/image' } } }], 'u1')
    assert.deepEqual(archived, [original])
    assert.equal(saved.length, 2)
    assert.ok(saved.every(input => input.mediaType === 'image/png'))
    assert.equal(result.parts.length, 2)
    assert.deepEqual(result.notes, [])
  })
})
