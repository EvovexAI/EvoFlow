import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/react/v4/evoflowV4Transport.ts', () => ({
  getEvoflowV4Transport: () =>
    new Proxy(
      {
        subscribe: vi.fn(async () => ({
          ack: { subscriptionId: 'sub-test', mode: 'snapshot', logEpoch: 'e1' },
        })),
        unsubscribe: vi.fn(async () => {}),
        queryCommands: vi.fn(async () => ({ commands: [] })),
      },
      {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver)
          if (String(prop).startsWith('on')) return () => () => {}
          return vi.fn(async () => ({}))
        },
      },
    ),
}))

describe('SessionDataLayer.releaseKeepWarmExcept', () => {
  it('closes keep-warm entries not in the keep set', async () => {
    const { SessionDataLayer } = await import('../src/zcode-ui/v4/sessionDataLayer.ts')
    const { getEvoflowV4Transport } = await import('../src/react/v4/evoflowV4Transport.ts')
    const layer = new SessionDataLayer({ transport: getEvoflowV4Transport() as never, keepWarmMs: 60_000 })

    const a = layer.acquire('thread-a', { intent: 'prefetch' })
    a.release()
    const b = layer.acquire('thread-b', { intent: 'prefetch' })
    b.release()
    expect(layer.size).toBe(2)

    const closed = layer.releaseKeepWarmExcept(['thread-b'])
    expect(closed).toBe(1)
    expect(layer.has('thread-a')).toBe(false)
    expect(layer.has('thread-b')).toBe(true)

    layer.dispose()
  })

  it('onlyWithoutSnapshot keeps warm caches that already have a snapshot', async () => {
    const { SessionDataLayer } = await import('../src/zcode-ui/v4/sessionDataLayer.ts')
    const { getEvoflowV4Transport } = await import('../src/react/v4/evoflowV4Transport.ts')
    const layer = new SessionDataLayer({ transport: getEvoflowV4Transport() as never, keepWarmMs: 60_000 })

    const warm = layer.acquire('thread-warm', { intent: 'prefetch' })
    const realGet = warm.store.getState.bind(warm.store)
    vi.spyOn(warm.store, 'getState').mockImplementation(() => ({
      ...realGet(),
      snapshot: {
        sessionId: 'thread-warm',
        rows: { window: [{ rowId: 'r1' }], totalCount: 1 },
      },
    }))
    warm.release()

    const cold = layer.acquire('thread-cold', { intent: 'prefetch' })
    cold.release()
    expect(layer.size).toBe(2)

    const closed = layer.releaseKeepWarmExcept(['thread-keep'], {
      onlyWithoutSnapshot: true,
    })
    expect(closed).toBe(1)
    expect(layer.has('thread-warm')).toBe(true)
    expect(layer.has('thread-cold')).toBe(false)

    layer.dispose()
  })

  it('limit + preferLargest closes largest idle keep-warm first', async () => {
    const { SessionDataLayer } = await import('../src/zcode-ui/v4/sessionDataLayer.ts')
    const { getEvoflowV4Transport } = await import('../src/react/v4/evoflowV4Transport.ts')
    const layer = new SessionDataLayer({ transport: getEvoflowV4Transport() as never, keepWarmMs: 60_000 })

    const small = layer.acquire('thread-small', { intent: 'prefetch' })
    const smallGet = small.store.getState.bind(small.store)
    vi.spyOn(small.store, 'getState').mockImplementation(() => ({
      ...smallGet(),
      snapshot: {
        sessionId: 'thread-small',
        rows: { window: [{ rowId: 'r1' }], totalCount: 10 },
      },
    }))
    small.release()

    const large = layer.acquire('thread-large', { intent: 'prefetch' })
    const largeGet = large.store.getState.bind(large.store)
    vi.spyOn(large.store, 'getState').mockImplementation(() => ({
      ...largeGet(),
      snapshot: {
        sessionId: 'thread-large',
        rows: { window: [{ rowId: 'r1' }, { rowId: 'r2' }], totalCount: 900 },
      },
    }))
    large.release()

    const keep = layer.acquire('thread-keep', { intent: 'prefetch' })
    keep.release()
    expect(layer.size).toBe(3)

    const closed = layer.releaseKeepWarmExcept(['thread-keep'], {
      limit: 1,
      preferLargest: true,
    })
    expect(closed).toBe(1)
    expect(layer.has('thread-large')).toBe(false)
    expect(layer.has('thread-small')).toBe(true)
    expect(layer.has('thread-keep')).toBe(true)

    layer.dispose()
  })
})
