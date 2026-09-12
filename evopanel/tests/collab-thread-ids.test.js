import { describe, expect, it } from 'vitest'
import {
  isCollabExecutorThread,
  isLanggraphLeadThreadId,
  resolveLanggraphLeadThreadId,
} from '../src/lib/collab-thread-ids.js'

describe('collab-thread-ids', () => {
  const lead = 'c5525aa9-d737-46f8-973c-fa82d8a9641d'
  const executor = `${lead}__sub__Subtask_20260531080703_623573`

  it('detects executor composite ids', () => {
    expect(isCollabExecutorThread(executor)).toBe(true)
    expect(isLanggraphLeadThreadId(executor)).toBe(false)
  })

  it('resolves lead uuid from executor composite', () => {
    expect(resolveLanggraphLeadThreadId(executor)).toBe(lead)
    expect(resolveLanggraphLeadThreadId(lead)).toBe(lead)
    expect(resolveLanggraphLeadThreadId('SubThread_orphan')).toBeNull()
  })
})
