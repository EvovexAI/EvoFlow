import { describe, it, expect } from 'vitest'
import { partialAbortPersistKey } from '../src/lib/ws-client.js'

describe('partialAbortPersistKey', () => {
  it('builds stable session+run key', () => {
    expect(partialAbortPersistKey('sess-1', 'run-a')).toBe('sess-1:run-a')
  })

  it('returns empty when session or run missing', () => {
    expect(partialAbortPersistKey('', 'run-a')).toBe('')
    expect(partialAbortPersistKey('sess-1', '')).toBe('')
  })
})
