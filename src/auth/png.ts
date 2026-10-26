/**
 * 极小的 PNG 写出器：把二维码矩阵画成图。
 *
 * 只为了「在聊天窗口里贴一张能扫的二维码」——不引第三方图像库（装依赖、体积、构建链都不值当），
 * 灰度 8 位 + zlib 就够。
 *
 * @module wechat-persona/auth/png
 */

import { deflateSync } from 'node:zlib'

/** CRC32 查表（PNG 每个 chunk 都要）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffff_ffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBytes = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBytes, Buffer.from(data)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/**
 * 把布尔矩阵渲染成 PNG。
 *
 * @param matrix - `matrix[row][col]`，true 为黑块。
 * @param options - 每个模块的像素数与静默区模块数。
 * @returns PNG 文件字节。
 */
export function matrixToPng(
  matrix: readonly (readonly boolean[])[],
  options: { scale?: number; margin?: number } = {},
): Buffer {
  const scale = options.scale ?? 8
  const margin = options.margin ?? 4
  const modules = matrix.length
  const size = (modules + margin * 2) * scale

  // 每行：1 字节滤波类型（0 = None）+ size 个灰度像素。
  const stride = size + 1
  const raw = Buffer.alloc(stride * size, 0xff)
  for (let row = 0; row < size; row += 1) raw[row * stride] = 0

  for (let y = 0; y < modules; y += 1) {
    const line = matrix[y]
    if (line === undefined) continue
    for (let x = 0; x < modules; x += 1) {
      if (line[x] !== true) continue
      for (let dy = 0; dy < scale; dy += 1) {
        const py = (y + margin) * scale + dy
        const base = py * stride + 1 + (x + margin) * scale
        raw.fill(0x00, base, base + scale)
      }
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // color type: grayscale
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ])
}
