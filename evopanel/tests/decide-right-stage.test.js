import { describe, expect, it } from 'vitest'
import { decideRightStage, RIGHT_STAGE_HINT_DELAY_MS } from '../src/lib/right-stage/decide-right-stage.ts'

const base = {
  runId: 'run-1',
  userPinned: null,
  dismissedKindsThisRun: new Set(),
  autoPreviewEnabled: true,
  currentKind: null,
}

describe('decideRightStage', () => {
  it('write: hint then show when auto preview on', () => {
    const r = decideRightStage({ ...base, intent: 'write', kind: 'write' })
    expect(r.action).toBe('hint')
    expect(r.kind).toBe('write')
    expect(r.delayMs).toBe(RIGHT_STAGE_HINT_DELAY_MS)
  })

  it('write: stream-only when auto preview off', () => {
    const r = decideRightStage({
      ...base,
      intent: 'write',
      kind: 'write',
      autoPreviewEnabled: false,
    })
    expect(r.action).toBe('stream-only')
  })

  it('respects pin of another kind', () => {
    const r = decideRightStage({
      ...base,
      intent: 'write',
      kind: 'write',
      userPinned: 'mind-map',
    })
    expect(r.action).toBe('stream-only')
    expect(r.reason).toContain('pinned')
  })

  it('respects dismissed kind this run', () => {
    const r = decideRightStage({
      ...base,
      intent: 'artifacts',
      kind: 'artifacts',
      dismissedKindsThisRun: new Set(['artifacts']),
    })
    expect(r.action).toBe('noop')
    expect(r.reason).toBe('artifacts-in-info-rail')
  })

  it('run-finished with artifacts stays in info rail', () => {
    const r = decideRightStage({
      ...base,
      intent: 'run-finished',
      hasArtifacts: true,
    })
    expect(r.action).toBe('noop')
    expect(r.reason).toBe('artifacts-in-info-rail')
  })

  it('run-finished with artifacts stays closed when auto preview off', () => {
    const r = decideRightStage({
      ...base,
      intent: 'run-finished',
      hasArtifacts: true,
      autoPreviewEnabled: false,
    })
    expect(r.action).toBe('noop')
    expect(r.reason).toBe('artifacts-in-info-rail')
  })

  it('artifacts: noop (handled in info rail)', () => {
    const r = decideRightStage({
      ...base,
      intent: 'artifacts',
      kind: 'artifacts',
      autoPreviewEnabled: false,
    })
    expect(r.action).toBe('noop')
    expect(r.reason).toBe('artifacts-in-info-rail')
  })

  it('artifacts: noop when already open', () => {
    const r = decideRightStage({
      ...base,
      intent: 'artifacts',
      kind: 'artifacts',
      currentKind: 'artifacts',
      autoPreviewEnabled: false,
    })
    expect(r.action).toBe('noop')
    expect(r.reason).toBe('artifacts-in-info-rail')
  })

  it('run-finished without artifacts schedules hide', () => {
    const r = decideRightStage({
      ...base,
      intent: 'run-finished',
      hasArtifacts: false,
    })
    expect(r.action).toBe('hide')
    expect(r.delayMs).toBeGreaterThan(0)
  })

  it('run-finished keeps platform-feedback panel open', () => {
    const r = decideRightStage({
      ...base,
      intent: 'run-finished',
      hasArtifacts: false,
      currentKind: 'platform-feedback',
    })
    expect(r.action).toBe('noop')
    expect(r.reason).toBe('platform-feedback-keep-on-finish')
  })

  it('collab yields to active write', () => {
    const r = decideRightStage({
      ...base,
      intent: 'collab-workflow',
      kind: 'collab-workflow',
      currentKind: 'write',
    })
    expect(r.action).toBe('noop')
    expect(r.reason).toBe('write-has-priority')
  })

  it('platform-feedback hints when panel is free', () => {
    const r = decideRightStage({
      ...base,
      intent: 'platform-feedback',
      kind: 'platform-feedback',
    })
    expect(r.action).toBe('hint')
    expect(r.kind).toBe('platform-feedback')
  })

  it('platform-feedback yields to active write', () => {
    const r = decideRightStage({
      ...base,
      intent: 'platform-feedback',
      kind: 'platform-feedback',
      currentKind: 'write',
    })
    expect(r.action).toBe('noop')
    expect(r.reason).toBe('higher-priority-open')
  })
})
