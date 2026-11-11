import { describe, expect, it, vi } from 'vitest'
import { SessionDataLayer } from '../src/zcode-ui/v4/sessionDataLayer.ts'

function stubTransport() {
  return {
    onFrame: () => () => {},
    onAssemblyFault: () => () => {},
    onRuntimeLifecycle: () => () => {},
    onRuntimeRestart: () => () => {},
    subscribe: async () => ({
      ack: {
        subscriptionId: 'sub-test',
        mode: 'snapshot',
        logEpoch: 1,
        openTiming: {},
      },
    }),
    activate: () => {},
    unsubscribe: async () => {},
    queryCommands: async () => ({ commands: [] }),
  }
}

describe('SessionDataLayer.peekStore + pin-style acquire', () => {
  it('peekStore returns null when unknown, store when acquired', () => {
    const layer = new SessionDataLayer({ transport: stubTransport(), keepWarmMs: 60_000 })
    expect(layer.peekStore('tid-1')).toBeNull()
    const lease = layer.acquire('tid-1')
    expect(layer.peekStore('tid-1')).toBe(lease.store)
    expect(layer.peekStore('tid-1')).toBe(layer.peekStore('tid-1'))
    lease.release()
    // still keep-warm: peek still works
    expect(layer.peekStore('tid-1')).not.toBeNull()
    layer.dispose()
  })

  it('held acquire (pin) keeps entry after another release', () => {
    const layer = new SessionDataLayer({ transport: stubTransport(), keepWarmMs: 60_000 })
    const pin = layer.acquire('tid-pin')
    const pane = layer.acquire('tid-pin')
    pane.release()
    // pin still holds refCount → entry stays hot
    expect(layer.has('tid-pin')).toBe(true)
    expect(layer.peekStore('tid-pin')).toBe(pin.store)
    pin.release()
    layer.dispose()
  })
})

describe('syncEvoflowV4PinnedSessions export', () => {
  it('exports sync + shared layer with peekStore', async () => {
    vi.resetModules()
    const mod = await import('../src/react/v4/V4StreamRowsBridge.tsx')
    expect(typeof mod.syncEvoflowV4PinnedSessions).toBe('function')
    expect(typeof mod.getSharedV4SessionDataLayer().peekStore).toBe('function')
    mod.syncEvoflowV4PinnedSessions([])
  })
})
