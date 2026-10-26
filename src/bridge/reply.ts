/**
 * 把模型回答发回微信。
 *
 * 两个决定塑造了这个文件：
 *
 * **回答来自 durable 事件。** `assistant/message` 才是会话日志里落定的东西；
 * 流式的 `assistant-stream` 是进程内的，没人订阅时就丢了，用它拼回复会在重载后缺块。
 *
 * **投递走队列。** 微信没有重放、没有投递回执，一次失败的发送就是用户永远看不到的消息。
 * 队列做有限次重试、保证同一 peer 的顺序、并让一个不可达的 peer 不拖住其他 peer。
 *
 * @module wechat-persona/bridge/reply
 */

import { splitText, type SplitMode } from './text.ts'

/** 服务端用来要求「慢一点」的返回码。 */
export const THROTTLE_CODE = -2

/** 第一次限流退避，毫秒。 */
const THROTTLE_BASE_MS = 2_000

/** 限流退避上限，毫秒。 */
const THROTTLE_MAX_MS = 16_000

/**
 * 这个错误是「慢一点」还是「被拒」。
 *
 * 结构化判断而不是 `instanceof`：错误类在协议层，这里只关心它带的码。
 * @param error - 发送被拒时抛出的值。
 */
export function isThrottled(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === THROTTLE_CODE
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 从一个会话事件里读出要发回的文本。
 *
 * 带工具调用的消息是「旁白」不是回答：模型每一步都会提交一条 `assistant/message`，
 * 大多数步骤是在说「接下来我要……」然后真的去调工具。单独发出去就停在一个冒号上。
 * 被中断的一轮没有回答，它残留的半句话也不发——那读起来像被截断的回复，比沉默更糟。
 *
 * @param event - 已提交的会话事件。
 * @returns 要发送的文本；这个事件不是回答时返回 undefined。
 */
export function extractAssistantText(event: unknown): string | undefined {
  if (!isRecord(event) || event['type'] !== 'assistant/message') return undefined
  const data = event['data']
  if (!isRecord(data)) return undefined
  if (data['interrupted'] === true) return undefined
  const message = data['message']
  if (!isRecord(message)) return undefined
  const content = message['content']
  if (!Array.isArray(content)) return undefined

  // 先看有没有工具调用：有就说明这条是本步的引子。
  const callsTool = content.some(block => isRecord(block) && block['type'] === 'tool-call')
  if (callsTool) return undefined

  const text = content
    .filter((block): block is { type: 'text'; text: string } =>
      isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string')
    .map(block => block.text)
    .join('')

  // 纯工具的一轮没有可展示的话；空消息在聊天里会渲染成一个空气泡。
  return text.trim() === '' ? undefined : text
}

/** 发一条回复；失败且可重试时应 reject。 */
export type ReplySender = (peerId: string, text: string, contextToken: string | undefined) => Promise<void>

export interface ReplyQueueOptions {
  send: ReplySender
  /** 普通失败最多尝试几次，默认 3。 */
  maxAttempts?: number
  /** 限流额外允许几次，默认 5。 */
  maxThrottleAttempts?: number
  /** 放弃时回调。 */
  onGiveUp?: (peerId: string, text: string, error: unknown) => void
  /** 普通重试间隔，毫秒。 */
  retryDelayMs?: number
  /** 同一 peer 两次发送的最小间隔，毫秒。 */
  minIntervalMs?: number
  /** 切成几条发，单条上限。 */
  maxChars?: number
  /** 切分粒度。 */
  splitMode?: SplitMode
  /** 测试注入的 sleep。 */
  sleep?: (ms: number) => Promise<void>
  /** 测试注入的时钟。 */
  now?: () => number
}

interface Queued {
  peerId: string
  text: string
  contextToken: string | undefined
}

/**
 * 每个 peer 一条串行队列。
 *
 * 同一 peer 的发送按入队顺序一次一条，慢的回复不会被下一条超车；不同 peer 互不阻塞。
 */
export class ReplyQueue {
  private readonly options: ReplyQueueOptions
  private readonly queues = new Map<string, Queued[]>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly lastSentAt = new Map<string, number>()

  constructor(options: ReplyQueueOptions) {
    this.options = options
  }

  /**
   * 入队一条回复。返回的 Promise 在这条回复彻底结束（发出或放弃）后 settle，
   * 不会因重试而 reject。
   */
  enqueue(peerId: string, text: string, contextToken?: string): Promise<void> {
    const queue = this.queues.get(peerId) ?? []
    queue.push({ peerId, text, contextToken })
    this.queues.set(peerId, queue)
    const existing = this.running.get(peerId)
    if (existing !== undefined) return existing
    const run = this.drain(peerId).finally(() => { this.running.delete(peerId) })
    this.running.set(peerId, run)
    return run
  }

  /** 某个 peer 是否还有未完成的工作。 */
  isBusy(peerId: string): boolean {
    return this.running.has(peerId) || (this.queues.get(peerId)?.length ?? 0) > 0
  }

  /** 等待所有 peer 的队列排空。 */
  async whenIdle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running.values()])
    }
  }

  private async drain(peerId: string): Promise<void> {
    for (;;) {
      const queue = this.queues.get(peerId)
      const next = queue?.shift()
      if (next === undefined) {
        this.queues.delete(peerId)
        return
      }
      await this.deliver(next)
    }
  }

  private async deliver(item: Queued): Promise<void> {
    const sleep = this.options.sleep ?? (async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) })
    const maxAttempts = this.options.maxAttempts ?? 3
    const maxThrottle = this.options.maxThrottleAttempts ?? 5
    const chunks = splitText(item.text, this.options.maxChars ?? 2_000, this.options.splitMode ?? 'paragraph')
    let throttleCount = 0
    let attempt = 0

    for (const chunk of chunks) {
      for (;;) {
        await this.pace(item.peerId, sleep)
        try {
          await this.options.send(item.peerId, chunk, item.contextToken)
          this.lastSentAt.set(item.peerId, (this.options.now ?? Date.now)())
          break
        } catch (error) {
          if (isThrottled(error) && throttleCount < maxThrottle) {
            // 限流是「慢一点」，不是「别发」：按指数退避重试同一条。
            throttleCount += 1
            const wait = Math.min(THROTTLE_MAX_MS, THROTTLE_BASE_MS * 2 ** (throttleCount - 1))
            await sleep(wait)
            continue
          }
          attempt += 1
          if (attempt >= maxAttempts) {
            this.options.onGiveUp?.(item.peerId, chunk, error)
            return
          }
          await sleep(this.options.retryDelayMs ?? 1_000)
        }
      }
    }
  }

  private async pace(peerId: string, sleep: (ms: number) => Promise<void>): Promise<void> {
    const minInterval = this.options.minIntervalMs ?? 0
    if (minInterval <= 0) return
    const last = this.lastSentAt.get(peerId)
    if (last === undefined) return
    const elapsed = (this.options.now ?? Date.now)() - last
    if (elapsed < minInterval) await sleep(minInterval - elapsed)
  }
}
