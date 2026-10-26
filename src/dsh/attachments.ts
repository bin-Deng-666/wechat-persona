/** Original media becomes ordered DSH attachments; cancellation stops downloads and stale work. */
import { downloadMedia, extractMedia, type InboundMedia } from '../ilink/media.ts'
import { sniffImageType } from '../media/image.ts'
import type { MessageItem } from '../ilink/types.ts'
import { previewGif } from '../media/gif.ts'

export interface AttachmentStoreLike {
  saveImages: (inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[]) => Promise<readonly unknown[]>
  saveFile: (input: { data: Uint8Array; name?: string }) => Promise<unknown>
}
export interface PrepareMediaOptions {
  store?: AttachmentStoreLike
  download?: (media: InboundMedia, signal?: AbortSignal) => Promise<Uint8Array>
  supportsImage?: () => Promise<boolean>
  report?: (line: string, detail?: unknown) => void
  onImage?: (input: { data: Uint8Array; mediaType: string; peerId?: string }) => Promise<string | void> | string | void
}
export interface PreparedMedia { parts: unknown[]; notes: string[] }
const LABELS: Record<InboundMedia['kind'], string> = { image: '图片', file: '文件', voice: '语音', video: '视频' }

export function createMediaPreparer(options: PrepareMediaOptions): (items: readonly MessageItem[] | undefined, peerId?: string, signal?: AbortSignal) => Promise<PreparedMedia> {
  const download = options.download ?? (async (media, signal) => await downloadMedia(media, { signal }))
  return async (items, peerId, signal) => {
    signal?.throwIfAborted()
    const media = extractMedia(items), parts: unknown[] = [], notes: string[] = []
    let supportsImages: boolean | undefined
    async function canSeeImages(): Promise<boolean> {
      if (supportsImages !== undefined) return supportsImages
      try { supportsImages = await options.supportsImage?.() ?? false }
      catch (error) { options.report?.('探测图片支持失败', { error: String(error) }); supportsImages = false }
      signal?.throwIfAborted()
      return supportsImages
    }
    for (const item of media) {
      signal?.throwIfAborted()
      const label = LABELS[item.kind]
      try {
        if (!options.store && !options.onImage) continue
        if (!options.store && item.kind !== 'image' && !(item.kind === 'file' && /\.(gif|png|jpe?g|webp)$/iu.test(item.name ?? ''))) continue
        const bytes = await download(item, signal)
        signal?.throwIfAborted()
        const mediaType = sniffImageType(bytes)
        if (item.kind === 'image' || mediaType !== undefined) {
          let imageId: string | void = undefined
          if (mediaType && options.onImage) {
            try { imageId = await options.onImage({ data: bytes, mediaType, ...(peerId === undefined ? {} : { peerId }) }) }
            catch (error) { options.report?.('图片素材保存失败', { error: String(error) }) }
          }
          signal?.throwIfAborted()
          if (!options.store) continue
          if (!(await canSeeImages())) { notes.push('（对方发来一张图片，但当前模型不支持看图）'); continue }
          if (!mediaType) { notes.push('（对方发来一张图片，但无法识别格式）'); continue }
          const name = imageId ?? item.name
          const inputs = mediaType === 'image/gif' ? previewGif(bytes).map((data, index) => ({ data, mediaType: 'image/png', name: `${name ?? 'gif'}-frame-${index + 1}.png` }))
            : [{ data: bytes, mediaType, ...(name === undefined ? {} : { name }) }]
          const refs = await options.store.saveImages(inputs)
          signal?.throwIfAborted()
          if (!refs.length) notes.push('（图片保存失败）')
          for (const ref of refs) parts.push({ type: 'image', attachment: ref })
        } else if (item.kind === 'file' && options.store) {
          const ref = await options.store.saveFile({ data: bytes, ...(item.name === undefined ? {} : { name: item.name }) })
          signal?.throwIfAborted(); parts.push({ type: 'file', attachment: ref })
        } else notes.push(`（对方发来一段${label}，暂不支持查看）`)
      } catch (error) {
        signal?.throwIfAborted()
        options.report?.(`${label}处理失败`, { error: String(error) })
        notes.push(`（对方发来一个${label}，但没能读取）`)
      }
    }
    if (!options.store && media.length) notes.push(`（收到${media.length}个附件，但当前宿主没有附件服务，无法查看）`)
    return { parts, notes }
  }
}
