/** 按魔数猜图片的 MIME；猜不出返回 undefined（调用方当作文件处理）。 */
export function sniffImageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | undefined {
  const head = bytes.subarray(0, 12)
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 4 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'image/gif'
  if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
    && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'image/webp'
  return undefined
}
