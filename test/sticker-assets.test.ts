/** 自动素材归档：去重、隔离、识别、拒绝截图与原件保存。 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { parseStickerTokens, StickerLibrary, extractStickerAnnotations, normalizeStickerName } from '../src/persona/stickers.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sticker-assets-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  return { root, library: new StickerLibrary(root) }
}

describe('自动表情素材库', () => {
  it('保留原件、内容去重，重启后仍可读取', async t => {
    const { root, library } = await fixture(t)
    const first = await library.capture('u1', GIF, 'image/gif')
    const again = await library.capture('u1', GIF, 'image/gif')
    assert.ok(first)
    assert.equal(again?.id, first.id)
    assert.equal((await library.catalog('u1')).length, 1)
    assert.deepEqual(await library.names('u1'), [])
    await library.adoptLatest('u1', '招手')
    const restarted = new StickerLibrary(root)
    const path = await restarted.find(first.id, 'u1')
    assert.ok(path?.endsWith('.gif'))
    assert.deepEqual(await readFile(path!), GIF)
    assert.equal((await readdir(join(root, 'assets', first.hash.slice(0, 2)))).length, 1)
  })

  it('收到图片先待判断，确认表情后带描述和场景进入可发送目录', async t => {
    const { library } = await fixture(t)
    const image = await library.capture('u1', PNG, 'image/png')
    assert.ok(image)
    assert.equal(await library.find(image.id, 'u1'), undefined)
    await library.annotate('u1', [{ id: image.id, name: '狗头', description: '柴犬眯眼笑', scenes: '调侃、自嘲' }])
    assert.deepEqual(await library.names('u1'), ['狗头'])
    assert.ok(await library.find(image.id, 'u1'))
    assert.match(await library.prompt('u1'), /柴犬眯眼笑/)
    assert.match(await library.prompt('u1'), /调侃、自嘲/)
  })

  it('不同联系人共用原件但不共享收藏、描述和访问权', async t => {
    const { library } = await fixture(t)
    const image = await library.capture('u1', PNG, 'image/png')
    assert.ok(image)
    await library.adoptLatest('u1', '私人表情')
    assert.equal(await library.find(image.id, 'u2'), undefined)
    await library.annotate('u2', [{ id: image.id, name: '盗用', description: '猜的', scenes: '未知' }])
    assert.deepEqual(await library.names('u2'), [])
    await library.capture('u2', PNG, 'image/png')
    assert.equal((await library.catalog('u2'))[0]?.status, 'pending')
    assert.equal(await library.find('私人表情', 'u2'), undefined)
  })

  it('截图可忽略且不能被模型之后自动升级；用户仍可明确收藏', async t => {
    const { library } = await fixture(t)
    const image = await library.capture('u1', PNG, 'image/png')
    assert.ok(image)
    await library.annotate('u1', [{ id: image.id, ignore: true }])
    await library.annotate('u1', [{ id: image.id, name: '截图', description: '截图', scenes: '截图' }])
    assert.deepEqual(await library.names('u1'), [])
    await library.adoptLatest('u1', '用户选图')
    assert.deepEqual(await library.names('u1'), ['用户选图'])
  })

  it('最近素材按接收顺序确定，PNG 后发 GIF 不会收藏旧 PNG；并发写入不丢条目', async t => {
    const { library } = await fixture(t)
    await library.capture('u1', PNG, 'image/png')
    const gif = await library.capture('u1', GIF, 'image/gif')
    await library.adoptLatest('u1', '刚才那张')
    assert.equal(await library.find('刚才那张', 'u1'), await library.find(gif!.id, 'u1'))
    await Promise.all(Array.from({ length: 5 }, (_, index) => library.capture('u1', Buffer.concat([PNG, Buffer.from([index])]), 'image/png')))
    assert.equal((await library.catalog('u1')).length, 7)
  })

  it('拒绝格式伪装与不支持格式', async t => {
    const { library } = await fixture(t)
    assert.equal(await library.capture('u1', GIF, 'image/png'), undefined)
    assert.equal(await library.capture('u1', PNG, 'image/tiff'), undefined)
    assert.equal(normalizeStickerName('../坏名字'), '..坏名字')
    assert.equal(normalizeStickerName('有 空格'), undefined)
  })
})

describe('表情识别控制标记', () => {
  it('标记不进入微信正文，提取识别或忽略动作', () => {
    const id = 's_1234567890abcdef1234'
    assert.deepEqual(extractStickerAnnotations(`哈哈 [收录表情:${id}|开心|猫咪大笑|开心和赞同]`), {
      text: '哈哈', annotations: [{ id, name: '开心', description: '猫咪大笑', scenes: '开心和赞同' }],
    })
    assert.deepEqual(extractStickerAnnotations(`[忽略图片:${id}]`), { text: '', annotations: [{ id, ignore: true }] })
    assert.deepEqual(extractStickerAnnotations('正文[收录表情:编造的ID|名|描述|场景]'), { text: '正文', annotations: [] })
  })
})

describe('多条表情标记的解析', () => {
  it('逐张列出名字，正文里不留标记', () => {
    assert.deepEqual(parseStickerTokens('好[表情:a] 的[表情：b]'), { names: ['a', 'b'], text: '好 的' })
    assert.deepEqual(parseStickerTokens('[表情:单独]'), { names: ['单独'], text: '' })
    assert.deepEqual(parseStickerTokens('纯文字'), { names: [], text: '纯文字' })
  })
})
