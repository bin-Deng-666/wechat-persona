/** GIF 仅生成有限 PNG 预览给视觉模型；保存和发送始终使用原始 GIF。 */
import { decompressFrames, parseGIF } from 'gifuct-js'
import { PNG } from 'pngjs'

export function previewGif(data: Uint8Array): Uint8Array[] {
  const gif = parseGIF(Uint8Array.from(data).buffer)
  const { width, height } = gif.lsd
  const count = gif.frames.filter(frame => 'image' in frame).length
  if (width < 1 || height < 1 || width * height > 4_000_000 || count < 1 || count > 180 || width * height * count > 32_000_000) {
    throw new Error('GIF 超过预览解码上限')
  }
  const frames = decompressFrames(gif, true)
  const selected = new Set([0, Math.floor((frames.length - 1) / 2), frames.length - 1])
  const canvas = new Uint8Array(width * height * 4)
  const previews: Uint8Array[] = []
  for (const [index, frame] of frames.entries()) {
    const { left, top, width: fw, height: fh } = frame.dims
    if (left + fw > width || top + fh > height) throw new Error('GIF 帧超出画布')
    const previous = frame.disposalType === 3 ? canvas.slice() : undefined
    for (let y = 0; y < fh; y += 1) {
      for (let x = 0; x < fw; x += 1) {
        const source = (y * fw + x) * 4
        if (frame.patch[source + 3] === 0) continue
        canvas.set(frame.patch.subarray(source, source + 4), ((top + y) * width + left + x) * 4)
      }
    }
    if (selected.has(index)) {
      previews.push(PNG.sync.write({ width, height, data: Buffer.from(canvas) } as PNG))
    }
    if (frame.disposalType === 2) {
      const background = frame.transparentIndex === undefined ? gif.gct?.[gif.lsd.backgroundColorIndex] : undefined
      const rgba = background === undefined ? [0, 0, 0, 0] : [...background, 255]
      for (let y = 0; y < fh; y += 1) for (let x = 0; x < fw; x += 1) canvas.set(rgba, ((top + y) * width + left + x) * 4)
    } else if (previous !== undefined) canvas.set(previous)
  }
  return previews
}
