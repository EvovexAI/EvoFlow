import { describe, expect, it } from 'vitest'
import {
  formatPlanTaskStatusLabel,
  isPlanAwaitingUserExecStart,
  isPlanExecDockEligible,
  isPlanFormulated,
  shouldAutoOpenCollabExecPanel,
  shouldShowCollabSubtaskSidebar,
  shouldShowCollabWorkflowPanel,
  PLAN_DOCK_TASK_STATUS,
} from '../src/lib/plan-task-status.js'

describe('plan-task-status', () => {
  it('PLAN_DOCK_TASK_STATUS is planned', () => {
    expect(PLAN_DOCK_TASK_STATUS).toBe('planned')
  })

  it('isPlanAwaitingUserExecStart when status planned and not authorized', () => {
    expect(
      isPlanAwaitingUserExecStart(
        { status: 'planned', executionAuthorized: false },
        { hasPlanBody: true },
      ),
    ).toBe(true)
  })

  it('isPlanAwaitingUserExecStart false when authorized', () => {
    expect(
      isPlanAwaitingUserExecStart(
        { status: 'planned', executionAuthorized: true },
        { hasPlanBody: true },
      ),
    ).toBe(false)
  })

  it('formatPlanTaskStatusLabel for planned', () => {
    expect(formatPlanTaskStatusLabel({ status: 'planned', executionAuthorized: false })).toBe(
      '待授权开始执行',
    )
    expect(formatPlanTaskStatusLabel({ status: 'planned', executionAuthorized: true })).toBe(
      '已授权，待启动',
    )
  })

  it('isPlanAwaitingUserExecStart true when boundPlanReady without status', () => {
    expect(
      isPlanAwaitingUserExecStart(
        { boundPlanReady: true, executionAuthorized: false },
        { hasPlanBody: true, boundPlanReady: true },
      ),
    ).toBe(true)
  })

  it('shouldShowCollabSubtaskSidebar false when planned and not authorized', () => {
    expect(
      shouldShowCollabSubtaskSidebar(
        { status: 'planned', executionAuthorized: false, boundPlanReady: true },
        { hasPlanBody: true },
      ),
    ).toBe(false)
  })

  it('shouldShowCollabSubtaskSidebar false when plan not formulated', () => {
    expect(
      shouldShowCollabSubtaskSidebar(
        { status: 'planned', executionAuthorized: true },
        {},
      ),
    ).toBe(false)
  })

  it('shouldShowCollabSubtaskSidebar true when planned but execution authorized', () => {
    expect(
      shouldShowCollabSubtaskSidebar(
        { status: 'planned', executionAuthorized: true, boundPlanReady: true },
        { hasPlanBody: true },
      ),
    ).toBe(true)
  })

  it('shouldShowCollabSubtaskSidebar true when executing', () => {
    expect(
      shouldShowCollabSubtaskSidebar(
        { status: 'executing', executionAuthorized: true },
        { hasPlanBody: true },
      ),
    ).toBe(true)
  })

  it('shouldShowCollabWorkflowPanel true while awaiting start (structure preview)', () => {
    expect(
      shouldShowCollabWorkflowPanel(
        { status: 'planned', executionAuthorized: false, boundPlanReady: true },
        { hasPlanBody: true },
      ),
    ).toBe(true)
  })

  it('shouldShowCollabWorkflowPanel false when terminal', () => {
    expect(
      shouldShowCollabWorkflowPanel(
        { status: 'completed', boundPlanReady: true },
        { hasPlanBody: true },
      ),
    ).toBe(false)
  })

  it('shouldAutoOpenCollabExecPanel on executing phase', () => {
    expect(
      shouldAutoOpenCollabExecPanel(
        { status: 'executing', executionAuthorized: true, boundPlanReady: true },
        { hasPlanBody: true, collabPhase: 'executing' },
      ),
    ).toBe(true)
    expect(
      shouldAutoOpenCollabExecPanel(
        { status: 'planned', executionAuthorized: false, boundPlanReady: true },
        { hasPlanBody: true, collabPhase: 'plan_ready' },
      ),
    ).toBe(false)
  })

  it('isPlanFormulated when goal or boundPlanReady present', () => {
    expect(isPlanFormulated({ boundPlanReady: true })).toBe(true)
    expect(isPlanFormulated({ planGoal: 'do something' })).toBe(true)
    expect(isPlanFormulated({}, { hasPlanBody: true })).toBe(true)
    expect(isPlanFormulated({})).toBe(false)
  })

  it('extractDispatchErrorMessage surfaces delegated subtask errors', async () => {
    const { extractDispatchErrorMessage } = await import('../src/lib/plan-exec-ui.js')
    const msg = extractDispatchErrorMessage({
      success: false,
      delegatedSubtasks: [{ subtaskId: 's1', ok: false, error: 'delegation failed: TypeError: x' }],
    })
    expect(msg).toContain('delegation failed')
  })

  it('isPlanExecDockEligible delegates to task status', () => {
    expect(
      isPlanExecDockEligible({
        collabTask: { status: 'planned', executionAuthorized: false },
        hasPlanBody: true,
      }),
    ).toBe(true)
    expect(
      isPlanExecDockEligible({
        collabTask: { status: 'executing', executionAuthorized: true },
        hasPlanBody: true,
      }),
    ).toBe(false)
  })
})
