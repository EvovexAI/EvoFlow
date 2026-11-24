import { describe, expect, it } from 'vitest'
import {
  collectPendingDrainCandidateKeys,
  patchPendingSendQueueForSession,
} from '../src/react/hooks/pending-send-queue-session.ts'

describe('pending-send-queue-session', () => {
  it('collects sessions with queue / inject / steer work', () => {
    const queues = new Map([
      ['sk-a', [{ id: '1', text: 'hello' }]],
      ['sk-empty', [] as { id: string; text: string }[]],
    ])
    const keys = collectPendingDrainCandidateKeys({
      queuesBySession: queues,
      midTurnInjects: [{ sessionKey: 'sk-b' }],
      pendingSteers: [{ sessionKey: 'sk-a' }, { sessionKey: 'sk-c' }],
    })
    expect(keys.sort()).toEqual(['sk-a', 'sk-b', 'sk-c'])
  })

  it('patches a background session queue without touching another bucket', () => {
    const queues = new Map([
      ['sk-a', [{ id: 'a1', text: 'queued-a' }]],
      ['sk-b', [{ id: 'b1', text: 'queued-b' }]],
    ])
    const nextA = patchPendingSendQueueForSession(queues, 'sk-a', (prev) =>
      prev.filter((x) => x.id !== 'a1'),
    )
    expect(nextA).toEqual([])
    expect(queues.get('sk-a')).toEqual([])
    expect(queues.get('sk-b')).toEqual([{ id: 'b1', text: 'queued-b' }])
  })
})
