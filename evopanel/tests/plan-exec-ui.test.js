import { describe, expect, it } from 'vitest'
import { resolvePlanExecHost } from '../src/lib/plan-exec-ui.js'

const planTool = (id) => ({
  name: 'plan',
  id,
  output: JSON.stringify({ success: true, boundTaskId: 'task-1' }),
})

describe('plan-exec-ui', () => {
  it('returns none when confirm is not active', () => {
    expect(
      resolvePlanExecHost({
        rows: [{ role: 'assistant', tools: [planTool('tc_plan')] }],
        hasConfirm: false,
      }),
    ).toEqual({ kind: 'none' })
  })

  it('attaches to the assistant row with a successful plan tool', () => {
    expect(
      resolvePlanExecHost({
        rows: [
          { role: 'user', text: 'go' },
          { role: 'assistant', tools: [planTool('tc_plan')] },
        ],
        anchorToolCallId: 'tc_plan',
        hasConfirm: true,
      }),
    ).toEqual({ kind: 'row', index: 1 })
  })

  it('attaches to stream while plan completes on the in-flight turn', () => {
    expect(
      resolvePlanExecHost({
        rows: [{ role: 'user', text: 'go' }],
        streamTools: [planTool('tc_stream_plan')],
        isSending: true,
        anchorToolCallId: 'tc_stream_plan',
        hasConfirm: true,
      }),
    ).toEqual({ kind: 'stream' })
  })

  it('falls back to the last assistant row when sidebar hydrated without plan tool row', () => {
    expect(
      resolvePlanExecHost({
        rows: [
          { role: 'user', text: 'go' },
          { role: 'assistant', text: '好的', tools: [] },
        ],
        hasConfirm: true,
      }),
    ).toEqual({ kind: 'row', index: 1 })
  })
})
