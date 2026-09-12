import { describe, expect, it } from 'vitest'
import {
  clearStreamReattachCooldown,
  isSessionRecoveryCooldownActive,
  isStreamReattachCooldownActive,
  markSessionRecoveryCooldown,
  markStreamReattachCooldown,
} from '../src/react/lib/stream-reattach-cooldown.js'
import { shouldSuppressAutoReattach } from '../src/react/lib/stream-resume-gate.ts'
import { dispatchSessionTurnEvent } from '../src/react/lib/session-runtime-store.js'

describe('stream-reattach-cooldown', () => {
  it('blocks reattach for same run during cooldown', () => {
    const sk = 'agent:main:cooldown-test'
    clearStreamReattachCooldown(sk)
    markStreamReattachCooldown(sk, 'run-1', 60_000)
    expect(isStreamReattachCooldownActive(sk, 'run-1')).toBe(true)
    expect(isStreamReattachCooldownActive(sk, 'run-2')).toBe(false)
    clearStreamReattachCooldown(sk)
    expect(isStreamReattachCooldownActive(sk, 'run-1')).toBe(false)
  })

  it('markSessionRecoveryCooldown blocks all runs for the session', () => {
    const sk = 'agent:main:recovery-cooldown'
    clearStreamReattachCooldown(sk)
    markSessionRecoveryCooldown(sk, 60_000)
    expect(isSessionRecoveryCooldownActive(sk)).toBe(true)
    expect(isStreamReattachCooldownActive(sk, 'any-run')).toBe(true)
    clearStreamReattachCooldown(sk)
  })

  it('clearStreamReattachCooldown unblocks intentional send after user stop', () => {
    const sk = 'agent:main:stop-then-send'
    clearStreamReattachCooldown(sk)
    markSessionRecoveryCooldown(sk, 90_000)
    expect(isSessionRecoveryCooldownActive(sk)).toBe(true)
    // ChatApp SEND_STARTED path must clear this so new AG-UI run-* is not dropped
    clearStreamReattachCooldown(sk)
    expect(isSessionRecoveryCooldownActive(sk)).toBe(false)
  })

  it('shouldSuppressAutoReattach respects cooldown', () => {
    const sk = 'agent:main:suppress-cooldown'
    clearStreamReattachCooldown(sk)
    dispatchSessionTurnEvent(sk, { type: 'REATTACH_DEGRADED', runId: 'run-a' })
    markStreamReattachCooldown(sk, 'run-a', 60_000)
    expect(
      shouldSuppressAutoReattach({
        sessionKey: sk,
        runId: 'run-a',
      }),
    ).toBe(true)
    clearStreamReattachCooldown(sk)
  })
})
