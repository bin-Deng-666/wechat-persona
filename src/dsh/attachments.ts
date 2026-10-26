/**
 * 把下载好的媒体变成会话消息里的内容块。
 *
 * 三种情况都必须退化成「文字说明」而不是「消息丢失」：
 * - 附件服务不存在（headless 组合）
 * - 当前模型不支持看图
 * - 下载或解密失败
 *
 * 因为一条带图的消息丢了图还可以读文字，丢了整条消息就什么也没有。
 *
 * @module wechat-persona/dsh/attachments
 */

/**
 * 把下载好的媒体变成会话消息里的内容块。
 *
 * 三种情况都必须退化成「文字说明」而不是「消息丢失」：
 * - 附件服务不存在（headless 组合）
 * - 当前模型不支持看图
 * - 下载或解密失败
 *
 * 因为一条带图的消息丢了图还可以读文字，丢了整条消息就什么也没有。
 *
 * @module wechat-persona/dsh/attachments
 */
import { downloadMedia, extractMedia, type InboundMedia } from '../ilink/media.ts'
/**
 * 把下载好的媒体变成会话消息里的内容块。
 *
 * 三种情况都必须退化成「文字说明」而不是「消息丢失」：
 * - 附件服务不存在（headless 组合）
 * - 当前模型不支持看图
 * - 下载或解密失败
 *
 * 因为一条带图的消息丢了图还可以读文字，丢了整条消息就什么也没有。
 *
 * @module wechat-persona/dsh/attachments
 */
import { sniffImageType } from '../media/image.ts'
import type { MessageItem } from '../ilink/types.ts'
import { previewGif } from '../media/gif.ts'

/** 附件存储里我们用到的两个方法（结构化，避免硬依赖）。 */
export interface AttachmentStoreLike {
  saveImages: (inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[]) => Promise<readonly unknown[]>
  saveFile: (input: { data: Uint8Array; name?: string }) => Promise<unknown>
}

export interface PrepareMediaOptions {
  /** 附件存储；缺失时只产出说明文字。 */
  store?: AttachmentStoreLike | undefined
  /** 下载器，默认走真实 CDN。 */
  download?: (media: InboundMedia) => Promise<Uint8Array>
  /** 当前模型是否支持图片输入。 */
  supportsImage?: () => Promise<boolean>
  /** 诊断出口。 */
  report?: (line: string, detail?: unknown) => void
  /**
   * 收到图片时的旁路回调（原始字节）。
   *
   * 用在「收表情」：不管当前模型能不能看图、这条消息会不会被投递，
   * 图片本身都值得留一份，用户才能说「把刚才那张收进表情库」。
   */
  onImage?: (input: { data: Uint8Array; mediaType: string; peerId?: string }) => Promise<string | void> | string | void
}

/** 一轮消息里附带的非文字内容。 */
export interface PreparedMedia {
  /** 可直接放进 `UserMessage.content` 的块。 */
  parts: unknown[]
  /** 拼进文本的说明，用于降级。 */
  notes: string[]
}

const KIND_LABEL: Record<InboundMedia['kind'], string> = {
  image: '图片',
  file: '文件',
  voice: '语音',
  video: '视频',
}

/**
 * 构造一个「把这条消息的媒体变成内容块」的函数。
 * @param options - 附件存储、下载器与能力探测。
 */
export function createMediaPreparer(
  options: PrepareMediaOptions,
): (items: readonly MessageItem[] | undefined, peerId?: string) => Promise<PreparedMedia> {
  const download = options.download ?? (async (media: InboundMedia) => await downloadMedia(media))

  return async (items, peerId) => {
    const media = extractMedia(items)
    const parts: unknown[] = []
    const notes: string[] = []
    if (media.length === 0) return { parts, notes }

    const store = options.store
    if (store === undefined) {
      // 没有附件服务也照样把图片旁路存一份：收表情不依赖模型能不能看图。
      for (const item of media) {
        const imageFile = item.kind === 'file' && /\.(gif|png|jpe?g|webp)$/iu.test(item.name ?? '')
        if ((!imageFile && item.kind !== 'image') || options.onImage === undefined) continue
        try {
          const bytes = await download(item)
          const mediaType = sniffImageType(bytes)
          if (mediaType !== undefined) await options.onImage({ data: bytes, mediaType, ...(peerId === undefined ? {} : { peerId }) })
        } catch {
          // 存不下就算了，正文还有说明文字。
        }
      }
      notes.push(`（收到${String(media.length)}个附件，但当前宿主没有附件服务，无法查看）`)
      return { parts, notes }
    }

    // 能力只探一次：同一轮里模型不会中途变成另一种模态。
    let imageSupport: boolean | undefined
    const canSeeImages = async (): Promise<boolean> => {
      if (imageSupport !== undefined) return imageSupport
      if (options.supportsImage === undefined) {
        imageSupport = false
        return false
      }
      try {
        imageSupport = await options.supportsImage()
      } catch (error) {
        // 探测失败不声称支持：发出去被拒会丢整条消息，只丢图片更划算。
        options.report?.('探测图片支持失败', { error: String(error) })
        imageSupport = false
      }
      return imageSupport
    }

    for (const item of media) {
      const label = KIND_LABEL[item.kind]
      try {
        const bytes = await download(item)
        const mediaType = sniffImageType(bytes)
        if (item.kind === 'image' || mediaType !== undefined) {
          let imageId: string | void = undefined
          if (mediaType !== undefined && options.onImage !== undefined) {
            // 旁路失败不影响这条消息：收藏是附赠，不是主线。
            try {
              imageId = await options.onImage({ data: bytes, mediaType, ...(peerId === undefined ? {} : { peerId }) })
            } catch (error) {
              options.report?.('图片旁路处理失败', { error: String(error) })
            }
          }
          if (!(await canSeeImages())) {
            notes.push('（对方发来一张图片，但当前模型不支持看图）')
            continue
          }
          if (mediaType === undefined) {
            notes.push('（对方发来一张图片，但无法识别格式）')
            continue
          }
          const name = imageId ?? item.name
          const inputs = mediaType === 'image/gif'
            ? previewGif(bytes).map((data, index) => ({ data, mediaType: 'image/png', name: `${name ?? 'gif'}-frame-${String(index + 1)}.png` }))
            : [{ data: bytes, mediaType, ...(name === undefined ? {} : { name }) }]
          const refs = await store.saveImages(inputs)
          if (refs.length === 0) {
            notes.push('（图片保存失败）')
            continue
          }
          for (const ref of refs) parts.push({ type: 'image', attachment: ref })
          continue
        }

        if (item.kind === 'file') {
          const ref = await store.saveFile({ data: bytes, ...(item.name === undefined ? {} : { name: item.name }) })
          parts.push({ type: 'file', attachment: ref })
          continue
        }

        // 语音/视频暂不投递给模型，只说明收到过。
        notes.push(`（对方发来一段${label}，暂不支持查看）`)
      } catch (error) {
        options.report?.(`${label}处理失败`, { error: String(error) })
        notes.push(`（对方发来一个${label}，但没能读取）`)
      }
    }

    return { parts, notes }
  }
}
