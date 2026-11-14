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
})
