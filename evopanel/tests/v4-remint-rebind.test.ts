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
})
