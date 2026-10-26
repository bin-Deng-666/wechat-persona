import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { StickerLibrary } from '../../src/stickers/library.ts'
const dirs: string[] = []
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }) })

describe('StickerLibrary', () => {
  async function library() {
    const root = await mkdtemp(join(tmpdir(), 'stickers-'))
    dirs.push(root)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, '开心.png'), 'png')
    await writeFile(join(root, '无语.gif'), 'gif')
    await writeFile(join(root, '说明.txt'), 'not a sticker')
    return new StickerLibrary(root)
  }

  it('按名字找到文件，忽略非图片', async () => {
    const lib = await library()
    assert.match((await lib.find('开心')) ?? '', /开心\.png$/)
    assert.match((await lib.find('无语')) ?? '', /无语\.gif$/)
    assert.equal(await lib.find('说明'), undefined)
  })

  it('names 只列图片', async () => {
    const lib = await library()
    assert.deepEqual((await lib.names()).sort(), ['无语', '开心'].sort())
  })

  it('没有目录时返回空而不抛错', async () => {
    const lib = new StickerLibrary(join(tmpdir(), 'definitely-not-there-' + String(Date.now())))
    assert.deepEqual(await lib.names(), [])
  })
})
