/**
 * 收表情：先存、再命名；不自动入库。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { StickerLibrary } from '../src/persona/stickers.ts'
import { normalizeStickerName, StickerInbox, stickerNameFromArgs } from '../src/persona/sticker-inbox.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('StickerInbox', () => {
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'sticker-inbox-'))
    const inbox = new StickerInbox(join(dir, 'inbox'))
    const library = new StickerLibrary(join(dir, 'stickers'))
    return { inbox, library, dir }
  }

  it('存下最近一张，能读回路径', async () => {
    const { inbox } = await setup()
    const path = await inbox.put('wxid-a', PNG, 'image/png')
    assert.ok(path?.endsWith('latest.png'))
    assert.equal(await inbox.latest('wxid-a'), path)
  })

  it('不认识的格式不落盘', async () => {
    const { inbox } = await setup()
    assert.equal(await inbox.put('wxid-a', PNG, 'image/tiff'), undefined)
    assert.equal(await inbox.latest('wxid-a'), undefined)
  })

  it('不同 peer 互不覆盖', async () => {
    const { inbox } = await setup()
    await inbox.put('a', PNG, 'image/png')
    await inbox.put('b', Buffer.concat([PNG, Buffer.from('x')]), 'image/png')
    assert.notEqual(await inbox.latest('a'), await inbox.latest('b'))
  })

  it('收下之后进表情库，名字能被找到', async () => {
    const { inbox, library } = await setup()
    await inbox.put('wxid-a', PNG, 'image/png')
    const saved = await inbox.adopt('wxid-a', '狗头', library)
    assert.equal(saved, '狗头.png')
    assert.ok((await library.names()).includes('狗头'))
    assert.ok((await library.find('狗头'))?.endsWith('狗头.png'))
  })

  it('没有素材时收不下', async () => {
    const { inbox, library } = await setup()
    assert.equal(await inbox.adopt('nobody', '狗头', library), undefined)
  })
})

describe('normalizeStickerName', () => {
  it('去掉方括号与路径字符', () => {
    assert.equal(normalizeStickerName('[狗头]'), '狗头')
    assert.equal(normalizeStickerName('a/b:c'), 'abc')
  })

  it('空名与超长名被拒', () => {
    assert.equal(normalizeStickerName('   '), undefined)
    assert.equal(normalizeStickerName('x'.repeat(25)), undefined)
  })

  it('从参数里取名字', () => {
    assert.equal(stickerNameFromArgs(['收', '猫', '猫']), '猫 猫')
    assert.equal(stickerNameFromArgs(['收']), undefined)
  })
})
