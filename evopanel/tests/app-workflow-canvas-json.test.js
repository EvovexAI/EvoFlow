import { describe, expect, it } from 'vitest'
import {
  canvasJsonToFlowSeed,
  flowToCanvasJson,
  migrateStepsToCanvas,
  normalizeCanvasRaw,
  stripStepCanvas,
} from '../src/react/lib/app-workflow-canvas-json.ts'
import {
  isMissingStepTaskName,
  normalizeSteps,
  stepsToExport,
} from '../src/react/lib/app-workflow-plan.ts'
import { flowToSteps, START_NODE_ID } from '../src/react/lib/app-workflow-flow.ts'

describe('app-workflow-canvas-json', () => {
  it('migrates legacy step.canvas + depends_on into canvas_json', () => {
    // 非平铺布局（y 间距 ≥ 48）才会走 legacy 坐标迁移；平铺视为未初始化，会被自动分层布局替换。
    const steps = normalizeSteps([
      { ref: '1', name: 'a', depends_on: [], canvas: { x: 100, y: 200 } },
      { ref: '2', name: 'b', depends_on: ['1'], canvas: { x: 400, y: 400 } },
    ])
    const canvas = migrateStepsToCanvas(steps)
    expect(canvas.nodes[0].nodeId).toBe(START_NODE_ID)
    expect(canvas.nodes.find((n) => n.nodeId === '1')?.position).toEqual({ x: 100, y: 200 })
    expect(canvas.edges.some((e) => e.source === '1' && e.target === '2')).toBe(true)
  })

  it('round-trips flow <-> canvas while steps drop nested canvas', () => {
    const steps = normalizeSteps([
      {
        ref: '1',
        name: '',
        description: 'research',
        assigned_agent: 'researcher',
        depends_on: [],
        canvas: { x: 120, y: 80 },
      },
      {
        ref: '2',
        name: '',
        description: 'write',
        assigned_agent: 'writer',
        depends_on: ['1'],
        canvas: { x: 440, y: 240 },
      },
    ])
    const canvas = migrateStepsToCanvas(steps)
    canvas.viewport = { x: 1, y: 2, zoom: 1.1 }

    const seed = canvasJsonToFlowSeed(stripStepCanvas(steps), canvas)
    expect(seed.nodes.find((n) => n.id === '1')?.position).toEqual({ x: 120, y: 80 })
    expect(seed.viewport?.zoom).toBe(1.1)

    const exportedSteps = flowToSteps(seed.nodes, seed.edges)
    const exportedCanvas = flowToCanvasJson(seed.nodes, seed.edges, seed.viewport)
    const plan = stepsToExport('goal', exportedSteps, exportedCanvas)

    expect(plan.canvas?.nodes.length).toBeGreaterThanOrEqual(2)
    expect(plan.steps.every((s) => !s.canvas)).toBe(true)
    expect(plan.steps.find((s) => s.ref === '2')?.depends_on).toContain('1')
    expect(plan.canvas?.viewport?.zoom).toBe(1.1)
  })

  it('stepsToExport keeps user step names and falls back when empty', () => {
    const steps = normalizeSteps([
      { ref: '1', name: '收集竞品', goal: '长说明', depends_on: [] },
      { ref: '2', name: '', goal: '清洗数据并入库\n第二行', depends_on: ['1'] },
      { ref: '3', name: '  ', depends_on: ['2'] },
    ])
    const plan = stepsToExport('goal', steps)
    expect(plan.steps.find((s) => s.ref === '1')?.name).toBe('收集竞品')
    expect(plan.steps.find((s) => s.ref === '2')?.name).toBe('清洗数据并入库')
    expect(plan.steps.find((s) => s.ref === '3')?.name).toBe('步骤 3')
    expect(isMissingStepTaskName('收集竞品')).toBe(false)
    expect(isMissingStepTaskName('步骤 1')).toBe(true)
    expect(isMissingStepTaskName('')).toBe(true)
  })

  it('normalizeCanvasRaw rejects empty / invalid payloads', () => {
    expect(normalizeCanvasRaw(null)).toBeNull()
    expect(normalizeCanvasRaw({})).toBeNull()
    expect(normalizeCanvasRaw({ nodes: [], edges: [] })).toBeNull()
    const ok = normalizeCanvasRaw({
      nodes: [{ nodeId: '1', type: 'agentStep', position: { x: 1, y: 2 } }],
      edges: [],
    })
    expect(ok?.nodes[0].position.x).toBe(1)
  })
})
