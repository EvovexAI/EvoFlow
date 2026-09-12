import { describe, expect, it } from 'vitest'
import {
  analyzePlanTools,
  absorbPlanInputFromTools,
  enrichToolsWithCachedPlanInput,
  evaluatePlanExecDock,
  extractBestPlanHitFromTools,
  historyPastPlanExecutionGate,
  mergePlanToolsForDetection,
  mergeToolsForPlanDetection,
  planHitFromToolRow,
} from '../src/lib/plan-pipeline.js'
import {
  pickRicherStructuredPlanInput,
  planInputFromTaskRow,
  resolvePlanStructuredForDock,
  structuredPlanFromTask,
} from '../src/lib/plan-from-task.js'

describe('plan-pipeline', () => {
  it('mergeToolsForPlanDetection prefers later source by tool id', () => {
    const merged = mergeToolsForPlanDetection(
      [{ id: 'a', name: '工具', input: { goal: 'g', steps: [{ name: 's' }] } }],
      [
        {
          id: 'a',
          name: '工具',
          output: { success: true, boundPlanReady: true, boundTaskId: 'Task_1' },
        },
      ],
    )
    expect(merged).toHaveLength(1)
    const hit = analyzePlanTools(merged).hit
    expect(hit?.taskId).toBe('Task_1')
    expect(hit?.boundPlanReady).toBe(true)
  })

  it('mergeToolsForPlanDetection keeps input when later snapshot only has failed output', () => {
    const merged = mergeToolsForPlanDetection(
      [
        {
          id: 'p1',
          name: 'plan',
          input: { goal: '目标', steps: [{ name: '步骤1' }] },
        },
      ],
      [
        {
          id: 'p1',
          name: 'plan',
          output: {
            success: false,
            plan: { goal: '目标', steps: [{ name: '步骤1' }] },
            error: 'bind failed',
          },
        },
      ],
    )
    const analyzed = analyzePlanTools(merged)
    expect(analyzed.hitKind).toBe('bind_failed')
    expect(analyzed.hit?.planInput?.goal).toBe('目标')
    const dock = evaluatePlanExecDock({
      planHit: analyzed.hit,
      collabPhase: 'plan_ready',
      collabTask: { executionAuthorized: false, status: 'planned' },
      planInputFallback: null,
      subtaskCount: 0,
      isSuppressed: false,
    })
    expect(dock.show).toBe(true)
  })

  it('mergePlanToolsForDetection merges stream with last row while streamActive', () => {
    const stream = [{ id: 'p1', name: 'plan', input: { goal: '流式', steps: [{ name: 's' }] } }]
    const history = [
      { id: 'p1', name: 'plan', output: { success: true, boundPlanReady: true, boundTaskId: 'Task_1' } },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, name: 'read_file' })),
    ]
    const active = mergePlanToolsForDetection(stream, history, true)
    expect(active).toHaveLength(6)
    const hit = analyzePlanTools(active).hit
    expect(hit?.planInput?.goal).toBe('流式')
    expect(hit?.taskId).toBe('Task_1')
  })

  it('pickRicherStructuredPlanInput prefers full input over truncated output summary', () => {
    const fullInput = {
      goal: '三步骤',
      steps: [{ name: 's1' }, { name: 's2' }, { name: 's3' }],
    }
    const truncatedOut = {
      goal: '三步骤',
      steps: [{ name: 's1' }],
    }
    expect(pickRicherStructuredPlanInput(truncatedOut, fullInput)?.steps).toHaveLength(3)
  })

  it('planHitFromToolRow does not set boundPlanReady without plan body', () => {
    const hit = planHitFromToolRow({
      name: 'plan',
      id: 'p-empty-out',
      input: { goal: '目标', steps: [{ name: '步骤1' }] },
      output: { success: true },
    })
    expect(hit?.boundPlanReady).toBeFalsy()
    expect(hit?.planInput?.steps).toHaveLength(1)
  })

  it('planHitFromToolRow keeps 3 input steps when output_text summary is truncated', () => {
    const hit = planHitFromToolRow({
      name: 'plan',
      id: 'p1',
      input: {
        goal: '三步骤',
        steps: [{ name: '生成任务1内容' }, { name: '任务2' }, { name: '任务3' }],
      },
      output_text:
        '[ToolResult summary — plan]\n{"success":true,"plan":{"goal":"三步骤","steps":[{"name":"生成任务1内容"}]',
    })
    expect(hit?.planInput?.steps).toHaveLength(3)
  })

  it('planHitFromToolRow reads goal/steps from top-level arguments during stream', () => {
    const hit = planHitFromToolRow({
      id: 'stream-plan-2',
      name: 'plan',
      arguments: JSON.stringify({
        goal: '流式目标2',
        steps: [{ name: '步骤B' }],
      }),
    })
    expect(hit?.planInput?.goal).toBe('流式目标2')
  })

  it('planHitFromToolRow reads goal/steps from function.arguments during stream', () => {
    const hit = planHitFromToolRow({
      id: 'stream-plan',
      name: 'plan',
      input: {},
      function: {
        name: 'plan',
        arguments: JSON.stringify({
          goal: '流式目标',
          steps: [{ name: '步骤A' }],
        }),
      },
    })
    expect(hit?.planInput?.goal).toBe('流式目标')
  })

  it('computePlanExecStripUi offers retry when authorized but not executing', async () => {
    const { computePlanExecStripUi } = await import('../src/lib/plan-exec-ui.ts')
    const ui = computePlanExecStripUi({
      executionAuthorized: true,
      status: 'planned',
      boundPlanReady: true,
      hasPlanToolSuccess: true,
    })
    expect(ui.showStartExecution).toBe(false)
    expect(ui.statusLabel).toContain('已授权')
  })

  it('evaluatePlanExecDock shows only when status=planned and not authorized', () => {
    const dock = evaluatePlanExecDock({
      planHit: { planInput: { goal: '目标', steps: [{ name: 's1' }] }, boundPlanReady: true },
      collabTask: {
        executionAuthorized: false,
        status: 'planned',
        boundPlanReady: true,
      },
      planInputFallback: { goal: '目标', steps: [{ name: 's1' }] },
      subtaskCount: 0,
      isSuppressed: false,
    })
    expect(dock.show).toBe(true)
    expect(dock.reason).toBe('ok')
  })

  it('evaluatePlanExecDock hides when already authorized', () => {
    const dock = evaluatePlanExecDock({
      planHit: { planInput: { goal: '目标', steps: [{ name: 's1' }] }, boundPlanReady: true },
      collabPhase: 'awaiting_exec',
      collabTask: {
        executionAuthorized: true,
        status: 'planned',
      },
      planInputFallback: { goal: '目标', steps: [{ name: 's1' }] },
      subtaskCount: 0,
      isSuppressed: false,
    })
    expect(dock.show).toBe(false)
    expect(dock.reason).toBe('already_authorized')
  })

  it('evaluatePlanExecDock hides when actively executing', () => {
    const dock = evaluatePlanExecDock({
      planHit: { planInput: { goal: '目标', steps: [{ name: 's1' }] }, boundPlanReady: true },
      collabPhase: 'executing',
      collabTask: { executionAuthorized: true, status: 'executing' },
      planInputFallback: null,
      subtaskCount: 3,
      isSuppressed: false,
    })
    expect(dock.show).toBe(false)
    expect(dock.reason).toBe('already_authorized')
  })

  it('evaluatePlanExecDock hides when suppressed after 开始执行 click', () => {
    const dock = evaluatePlanExecDock({
      planHit: { planInput: { goal: '目标', steps: [{ name: 's1' }] }, boundPlanReady: true },
      collabPhase: 'plan_ready',
      collabTask: {
        executionAuthorized: false,
        status: 'planned',
        boundPlanReady: true,
      },
      planInputFallback: { goal: '目标', steps: [{ name: 's1' }] },
      subtaskCount: 0,
      isSuppressed: true,
    })
    expect(dock.show).toBe(false)
    expect(dock.reason).toBe('suppressed')
  })

  it('enrichToolsWithCachedPlanInput recovers hit from name-only plan rows', () => {
    const enriched = enrichToolsWithCachedPlanInput(
      [{ id: 'p1', name: 'plan' }],
      { planInput: { goal: 'cached goal', steps: [{ name: 's1' }, { name: 's2' }] } },
    )
    const analyzed = analyzePlanTools(enriched)
    expect(analyzed.hit?.planInput?.goal).toBe('cached goal')
    expect(analyzed.hitKind).toBe('input_only')
  })

  it('absorbPlanInputFromTools keeps stream args after final name-only row', () => {
    const stream = [
      {
        id: 'p1',
        name: 'plan',
        function: {
          name: 'plan',
          arguments: JSON.stringify({
            goal: '流式目标',
            steps: [{ name: 's1' }, { name: 's2' }],
          }),
        },
      },
    ]
    let acc = absorbPlanInputFromTools(null, stream)
    acc = absorbPlanInputFromTools(acc, [{ id: 'p1', name: 'plan' }])
    expect(acc?.goal).toBe('流式目标')
    expect(acc?.steps).toHaveLength(2)
  })

  it('resolvePlanStructuredForDock prefers API task row over empty latch', () => {
    const resolved = resolvePlanStructuredForDock(
      { goal: 'partial' },
      planInputFromTaskRow({
        plan_goal: '完整目标',
        plan_steps: [{ name: 's1' }, { name: 's2' }],
      }),
    )
    expect(resolved?.goal).toBe('完整目标')
    expect(resolved?.steps).toHaveLength(2)
  })

  it('evaluatePlanExecDock hides when task completed (reload finished session)', () => {
    const dock = evaluatePlanExecDock({
      planHit: { planInput: { goal: '目标', steps: [{ name: 's1' }] }, boundPlanReady: true },
      collabPhase: 'idle',
      collabTask: { status: 'completed', boundPlanReady: true },
      planInputFallback: { goal: '目标', steps: [{ name: 's1' }] },
      subtaskCount: 3,
      isSuppressed: false,
      streamPlanLatched: true,
    })
    expect(dock.show).toBe(false)
    expect(dock.reason).toBe('terminal_status')
  })

  it('historyPastPlanExecutionGate detects user 开始执行', () => {
    expect(
      historyPastPlanExecutionGate([
        { role: 'assistant', tools: [{ output: { success: true, boundPlanReady: true } }] },
        { role: 'user', text: '开始执行' },
      ]),
    ).toBe(true)
  })

  it('evaluatePlanExecDock hides on streamPlanLatched when phase is idle after execution', () => {
    const dock = evaluatePlanExecDock({
      planHit: null,
      collabPhase: 'idle',
      collabTask: { status: 'completed' },
      planInputFallback: null,
      subtaskCount: 0,
      isSuppressed: false,
      planRowCount: 1,
      streamPlanLatched: true,
      latchedPlanInput: null,
    })
    expect(dock.show).toBe(false)
    expect(dock.reason).toBe('terminal_status')
  })

  it('evaluatePlanExecDock hides on streamPlanLatched during planning only', () => {
    const dock = evaluatePlanExecDock({
      planHit: null,
      collabPhase: 'planning',
      collabTask: null,
      planInputFallback: null,
      subtaskCount: 0,
      isSuppressed: false,
      planRowCount: 1,
      streamPlanLatched: true,
      latchedPlanInput: null,
    })
    expect(dock.show).toBe(false)
    expect(dock.reason).toBe('status_not_planned')
  })

  it('evaluatePlanExecDock shows on streamPlanLatched when status planned', () => {
    const dock = evaluatePlanExecDock({
      planHit: null,
      collabTask: { executionAuthorized: false, status: 'planned', boundPlanReady: true },
      planInputFallback: { goal: '流式', steps: [{ name: 's1' }] },
      subtaskCount: 0,
      isSuppressed: false,
      planRowCount: 1,
      streamPlanLatched: true,
      latchedPlanInput: { goal: '流式', steps: [{ name: 's1' }] },
    })
    expect(dock.show).toBe(true)
    expect(dock.reason).toBe('stream_latch')
  })

  it('evaluatePlanExecDock shows when only planInputFallback has goal in plan_ready', () => {
    const dock = evaluatePlanExecDock({
      planHit: null,
      collabPhase: 'plan_ready',
      collabTask: { executionAuthorized: false, status: 'planned' },
      planInputFallback: { goal: 'fallback', steps: [{ name: 'a' }] },
      subtaskCount: 0,
      isSuppressed: false,
      planRowCount: 1,
    })
    expect(dock.show).toBe(true)
    expect(dock.reason).toBe('ok')
  })

  it('evaluatePlanExecDock shows plan_ready_phase when status missing but phase plan_ready', () => {
    const dock = evaluatePlanExecDock({
      planHit: { boundPlanReady: true, planInput: { goal: 'g', steps: [] } },
      collabPhase: 'plan_ready',
      collabTask: { executionAuthorized: false },
      subtaskCount: 0,
      isSuppressed: false,
      planRowCount: 1,
    })
    expect(dock.show).toBe(true)
    expect(dock.reason).toBe('plan_ready_phase')
  })

  it('mergeToolsForPlanDetection on final keeps stream plan input when fin row is name-only', () => {
    const merged = mergeToolsForPlanDetection(
      [
        {
          id: 'p1',
          name: 'plan',
          function: {
            name: 'plan',
            arguments: JSON.stringify({
              goal: '三步骤',
              steps: [{ name: 's1' }, { name: 's2' }],
            }),
          },
        },
      ],
      [{ id: 'p1', name: 'plan' }],
    )
    const analyzed = analyzePlanTools(merged)
    expect(analyzed.hit?.planInput?.goal).toBe('三步骤')
    expect(analyzed.hit?.planInput?.steps).toHaveLength(2)
  })

  it('mergeToolsForPlanDetection keeps richer plan when name-only row is merged last', () => {
    const merged = mergeToolsForPlanDetection(
      [{ id: 'p1', name: 'plan' }],
      [
        {
          id: 'p1',
          name: 'plan',
          input: { goal: '落库目标', steps: [{ name: 'a' }, { name: 'b' }] },
          output: { success: true, boundPlanReady: true, boundTaskId: 'Task_x' },
        },
      ],
    )
    const analyzed = analyzePlanTools(merged)
    expect(analyzed.hitKind).toBe('output')
    expect(analyzed.hit?.planInput?.goal).toBe('落库目标')
    expect(analyzed.hit?.taskId).toBe('Task_x')
  })

  it('extractBestPlanHitFromTools ignores trailing name-only plan row', () => {
    const tools = [
      {
        id: 'p1',
        name: 'plan',
        input: { goal: '完整计划', steps: [{ name: 'a' }, { name: 'b' }] },
        output: { success: true, boundPlanReady: true, boundTaskId: 'Task_1' },
      },
      { id: 'p2', name: 'plan' },
    ]
    const hit = extractBestPlanHitFromTools(tools)
    expect(hit?.planInput?.goal).toBe('完整计划')
    expect(hit?.taskId).toBe('Task_1')
    expect(analyzePlanTools(tools).hitKind).toBe('output')
  })

  it('coalesces anon plan rows when fin and stream use different ids', () => {
    const merged = mergeToolsForPlanDetection(
      [
        {
          name: 'plan',
          input: { goal: '流式', steps: [{ name: 's1' }] },
        },
      ],
      [
        {
          id: 'fin-plan',
          name: 'plan',
          output: { success: true, boundPlanReady: true, boundTaskId: 'Task_z' },
        },
      ],
    )
    const analyzed = analyzePlanTools(merged)
    expect(analyzed.planRows.length).toBe(1)
    expect(analyzed.hit?.planInput?.goal).toBe('流式')
    expect(analyzed.hit?.taskId).toBe('Task_z')
  })

  it('evaluatePlanExecDock hides when plan input only but still planning', () => {
    const analyzed = analyzePlanTools([
      {
        name: '工具',
        id: 'p1',
        input: { goal: '目标', steps: [{ name: '步骤1' }] },
      },
    ])
    const dock = evaluatePlanExecDock({
      planHit: analyzed.hit,
      collabPhase: 'planning',
      collabTask: null,
      planInputFallback: null,
      subtaskCount: 0,
      isSuppressed: false,
    })
    expect(dock.show).toBe(false)
    expect(dock.reason).toBe('status_not_planned')
  })

  it('structuredPlanFromTask resolves subtask assigned_agent_name for step assigneeDisplay', () => {
    const parsed = structuredPlanFromTask({
      plan_goal: '目标',
      plan_steps: [{ name: '调研', assigned_agent: 'project-planner' }],
      subtasks: [
        {
          id: 'Task_1_1',
          name: 'Step 1: 调研',
          assigned_to: 'project-planner',
          assigned_agent_name: '项目·计划',
        },
      ],
    })
    expect(parsed?.steps[0]?.assignee).toBe('project-planner')
    expect(parsed?.steps[0]?.assigneeDisplay).toBe('项目·计划')
  })
})
