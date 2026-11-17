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

describe('SessionDataLayer.rebindSessionId (stream-404 remint)', () => {
  it('keeps the same store warm under the new thread id', async () => {
    const { SessionDataLayer } = await import('../src/zcode-ui/v4/sessionDataLayer.ts')
    const { getEvoflowV4Transport } = await import('../src/react/v4/evoflowV4Transport.ts')
    const layer = new SessionDataLayer({
      transport: getEvoflowV4Transport() as never,
      keepWarmMs: 60_000,
    })

    const oldId = '11111111-1111-4111-8111-111111111111'
    const newId = '22222222-2222-4222-8222-222222222222'
    const lease = layer.acquire(oldId)
    const store = lease.store

    // Seed snapshot through private setState (runtime-visible).
    ;(store as unknown as { setState: (p: object) => void }).setState({
      status: 'live',
      snapshot: {
        sessionId: oldId,
        logEpoch: 'e1',
        seq: 3,
        rows: { totalCount: 12, window: [{ id: 'r1' }] },
      },
    })

    expect(layer.rebindSessionId(oldId, newId)).toBe(true)
    expect(layer.has(oldId)).toBe(true)
    expect(layer.has(newId)).toBe(true)
    expect(layer.peekStore(newId)).toBe(store)
    expect(store.topic).toBe(`conversation/${newId}`)
    expect(store.getState().snapshot?.sessionId).toBe(newId)
    expect(store.getState().snapshot?.rows?.totalCount).toBe(12)

    const next = layer.acquire(newId)
    expect(next.store).toBe(store)
    expect(['warm', 'keep_warm']).toContain(next.openKind)

    lease.release()
    next.release()
    layer.dispose()
  })

  it('returns false when old thread has no projection', async () => {
    const { SessionDataLayer } = await import('../src/zcode-ui/v4/sessionDataLayer.ts')
    const { getEvoflowV4Transport } = await import('../src/react/v4/evoflowV4Transport.ts')
    const layer = new SessionDataLayer({
      transport: getEvoflowV4Transport() as never,
      keepWarmMs: 60_000,
    })
    expect(
      layer.rebindSessionId(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ),
    ).toBe(false)
    layer.dispose()
  })

  it('evicts empty new-topic occupant then rebinds (prefetch race)', async () => {
    const { SessionDataLayer } = await import('../src/zcode-ui/v4/sessionDataLayer.ts')
    const { getEvoflowV4Transport } = await import('../src/react/v4/evoflowV4Transport.ts')
    const layer = new SessionDataLayer({
      transport: getEvoflowV4Transport() as never,
      keepWarmMs: 60_000,
    })
    const oldId = '33333333-3333-4333-8333-333333333333'
    const newId = '44444444-4444-4444-8444-444444444444'
    const oldLease = layer.acquire(oldId)
    ;(oldLease.store as unknown as { setState: (p: object) => void }).setState({
      status: 'live',
      snapshot: {
        sessionId: oldId,
        logEpoch: 'e1',
        seq: 2,
        rows: { totalCount: 5, window: [{ id: 'a' }] },
      },
    })
    // Prefetch / cold open 已占住新 tid，但还没有任何窗口行
    const emptyLease = layer.acquire(newId)
    expect(emptyLease.store.getState().snapshot).toBeFalsy()

    expect(layer.rebindSessionId(oldId, newId)).toBe(true)
    expect(layer.peekStore(newId)).toBe(oldLease.store)
    expect(oldLease.store.getState().snapshot?.rows?.totalCount).toBe(5)

    oldLease.release()
    emptyLease.release()
    layer.dispose()
  })

  it('does not overwrite a populated new-topic store (normal use safety)', async () => {
    const { SessionDataLayer } = await import('../src/zcode-ui/v4/sessionDataLayer.ts')
    const { getEvoflowV4Transport } = await import('../src/react/v4/evoflowV4Transport.ts')
    const layer = new SessionDataLayer({
      transport: getEvoflowV4Transport() as never,
      keepWarmMs: 60_000,
    })
    const oldId = '55555555-5555-4555-8555-555555555555'
    const newId = '66666666-6666-4666-8666-666666666666'
    const oldLease = layer.acquire(oldId)
    ;(oldLease.store as unknown as { setState: (p: object) => void }).setState({
      status: 'live',
      snapshot: {
        sessionId: oldId,
        logEpoch: 'e1',
        seq: 1,
        rows: { totalCount: 2, window: [{ id: 'old' }] },
      },
    })
    const newLease = layer.acquire(newId)
    ;(newLease.store as unknown as { setState: (p: object) => void }).setState({
      status: 'live',
      snapshot: {
        sessionId: newId,
        logEpoch: 'e2',
        seq: 9,
        rows: { totalCount: 20, window: [{ id: 'keep' }] },
      },
    })

    expect(layer.rebindSessionId(oldId, newId)).toBe(false)
    expect(layer.peekStore(newId)).toBe(newLease.store)
    expect(newLease.store.getState().snapshot?.rows?.totalCount).toBe(20)

    oldLease.release()
    newLease.release()
    layer.dispose()
  })
})
