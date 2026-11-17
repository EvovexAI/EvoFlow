import { describe, expect, it, vi, beforeEach } from 'vitest'

describe('v4-snapshot-disk-cache', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('schedules and loads slim snapshot from memory fallback', async () => {
    const mod = await import('../src/react/v4/v4-snapshot-disk-cache.ts')
    const snap = {
      sessionId: 'thread-disk-1',
      rows: {
        window: Array.from({ length: 5 }, (_, i) => ({
          rowId: i + 1,
          kind: 'assistantText',
        })),
        totalCount: 5,
        firstRowId: 1,
      },
      control: {},
      queue: { items: [] },
      logEpoch: '1',
      seq: 5,
    } as never

    mod.scheduleV4SnapshotDiskCache('thread-disk-1', snap)
    await new Promise((r) => setTimeout(r, 1_400))
    const loaded = await mod.loadV4SnapshotDiskCache('thread-disk-1')
    expect(loaded).toBeTruthy()
    expect(loaded?.rows?.window?.length).toBe(5)
    expect(loaded?.rows?.totalCount).toBe(5)
  })
})
