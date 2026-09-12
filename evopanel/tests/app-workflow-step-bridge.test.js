import { describe, expect, it } from 'vitest'
import {
  buildWorkflowStepBridge,
  collectWorkflowRunDeliverables,
  findWorkflowStepDetail,
  listInspectableWorkflowSteps,
  resolveWorkflowStepRef,
  stripRuntimeStepPrefix,
} from '../src/lib/app-workflow-step-bridge.js'

const PLAN = [
  { ref: 'brief', name: '分镜与口播', assigned_agent: 'media-screenwriter', depends_on: [] },
  { ref: 'prompts', name: '生图分镜 Prompt', assigned_agent: 'media-visual-planner', depends_on: ['brief'] },
  { ref: 'assemble', name: '拼接成片', assigned_agent: 'media-post', depends_on: ['videos'] },
]

const RUNTIME = [
  {
    ref: '1',
    name: 'Step 1: 分镜与口播',
    status: 'completed',
    assigned_agent: 'media-screenwriter',
    outputs: [{ type: 'file', key: 'brief', value: 'outputs/production-brief.md' }],
  },
  {
    ref: '2',
    name: 'Step 2: 生图分镜 Prompt',
    status: 'completed',
    outputs: [],
  },
  {
    ref: '5',
    name: 'Step 5: 拼接成片',
    status: 'completed',
    semantic_ref: 'assemble',
    outputs: [{ type: 'file', key: 'final', value: 'outputs/final.mp4' }],
  },
]

describe('stripRuntimeStepPrefix', () => {
  it('removes Step N prefix', () => {
    expect(stripRuntimeStepPrefix('Step 3: 生成关键帧')).toBe('生成关键帧')
  })
})

describe('listInspectableWorkflowSteps', () => {
  it('merges plan and runtime without duplicate refs', () => {
    const steps = listInspectableWorkflowSteps(PLAN, RUNTIME)
    expect(steps).toHaveLength(3)
    expect(steps.map((s) => s.ref)).toEqual(['1', '2', '5'])
    expect(steps[0].name).toBe('分镜与口播')
    expect(steps[2].name).toBe('拼接成片')
  })
})

describe('resolveWorkflowStepRef', () => {
  it('maps semantic plan ref to runtime ref', () => {
    const bridge = buildWorkflowStepBridge(PLAN, RUNTIME)
    expect(resolveWorkflowStepRef('brief', bridge)).toBe('1')
    expect(resolveWorkflowStepRef('assemble', bridge)).toBe('5')
  })
})

describe('findWorkflowStepDetail', () => {
  it('finds runtime detail when queried by plan semantic ref', () => {
    const detail = findWorkflowStepDetail(
      { steps: RUNTIME, subtask_status: { 1: 'completed' } },
      'brief',
      PLAN,
    )
    expect(detail.ref).toBe('1')
    expect(detail.outputs).toHaveLength(1)
    expect(detail.outputs[0].value).toBe('outputs/production-brief.md')
  })

  it('resolves subtask_id through alias refs', () => {
    const detail = findWorkflowStepDetail(
      {
        steps: RUNTIME,
        subtask_status: { 1: 'completed' },
        step_ref_to_subtask_id: { 1: 'Subtask_abc' },
      },
      'brief',
      PLAN,
    )
    expect(detail.subtask_id).toBe('Subtask_abc')
  })
})

describe('collectWorkflowRunDeliverables', () => {
  it('falls back to answer_from_ref via semantic alias', () => {
    const items = collectWorkflowRunDeliverables(
      { steps: RUNTIME, outputs: [], answer_from_ref: 'assemble' },
      PLAN,
    )
    expect(items).toHaveLength(1)
    expect(items[0].value).toBe('outputs/final.mp4')
  })

  it('falls back to last successful step outputs', () => {
    const items = collectWorkflowRunDeliverables(
      { steps: RUNTIME, outputs: [] },
      PLAN,
    )
    expect(items).toHaveLength(1)
    expect(items[0].value).toBe('outputs/final.mp4')
  })
})
