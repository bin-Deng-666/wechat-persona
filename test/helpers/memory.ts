import type { PeerMemory } from '../../src/memory/store.ts'
import { createProposal } from '../../src/memory/model.ts'
/** Synthetic, source-backed communication preference for prompt tests. */
export async function preference(memory: PeerMemory, peerId: string, content: string) {
  return await memory.apply(peerId, createProposal({ title: content, content, type: '稳定偏好', scope: '回答与沟通', certainty: '明确', tags: ['沟通'],
    sources: [{ sessionId: 'test', entryId: 'user-source', fingerprint: 'fixture', quote: content, timestamp: new Date().toISOString() }] }))
}
