/** Private, atomic JSON publication. Failures leave the last committed file intact. */
import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function atomicJson(file: string, value: unknown, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temp, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync() }
    finally { await handle.close() }
    signal?.throwIfAborted()
    await rename(temp, file)
  } finally { await unlink(temp).catch(() => {}) }
}

/** One owner per document; serialize mutations, including recovery after a rejected write. */
export class SerialWork {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => {}).then(work)
    this.tail = next
    return next
  }
  async idle(): Promise<void> { await this.tail.catch(() => {}) }
}
