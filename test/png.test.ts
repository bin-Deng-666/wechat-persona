/**
 * PNG 写出器的测试：签名、尺寸、放大倍数。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { matrixToPng } from '../scripts/png.ts'

function matrix(size: number): boolean[][] {
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => (row + col) % 2 === 0))
}

describe('matrixToPng', () => {
  it('输出合法 PNG 签名与 IHDR 尺寸', () => {
    const png = matrixToPng(matrix(21), { scale: 8, margin: 4 })
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // 21 模块 + 两侧各 4 个静默模块 = 29，乘 8 像素
    assert.equal(png.readUInt32BE(16), (21 + 8) * 8)
    assert.equal(png.readUInt32BE(20), (21 + 8) * 8)
  })

  it('scale 影响像素尺寸', () => {
    const small = matrixToPng(matrix(21), { scale: 2, margin: 0 })
    assert.equal(small.readUInt32BE(16), 42)
  })

  it('以 IEND 结尾', () => {
    const png = matrixToPng(matrix(25))
    assert.deepEqual([...png.subarray(png.length - 8, png.length - 4)], [...Buffer.from('IEND', 'ascii')])
  })
})
