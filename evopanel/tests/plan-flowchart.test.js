import { describe, expect, it } from 'vitest'
import { pickRicherStructuredPlanInput } from '../src/lib/plan-from-task.js'
import {
  flowchartMermaidFromSteps,
  resolvePlanFlowchartMermaid,
  sanitizeMermaidNodeLabels,
} from '../src/react/lib/parse-plan-markdown.js'

describe('plan flowchart', () => {
  it('sanitizeMermaidNodeLabels converts stadium quotes and windows paths', () => {
    const raw =
      "flowchart TD\n    server['server/ (Express 后端)']\n    demo2['D:\\\\dev\\\\coding\\\\demo2']"
    const out = sanitizeMermaidNodeLabels(raw)
    expect(out).toContain('server["server/ (Express 后端)"]')
    expect(out).toContain('demo2["D:/dev/coding/demo2"]')
    expect(out).not.toContain("['")
  })

  it('sanitizeMermaidNodeLabels replaces double quotes in node labels', () => {
    const raw =
      'flowchart TD\n    S1[Step1: 生成"任务1执行完毕"内容 → task1.txt]\n    S1 --> S2'
    const out = sanitizeMermaidNodeLabels(raw)
    expect(out).toContain("生成'任务1执行完毕'内容")
    expect(out).not.toContain('"任务1')
  })

  it('flowchartMermaidFromSteps builds dependency edges', () => {
    const code = flowchartMermaidFromSteps([
      { ref: '1', shortName: '写 task1.txt', dependsOn: [] },
      { ref: '2', shortName: '写 task2.txt', dependsOn: ['1'] },
      { ref: '3', shortName: '写 task3.txt', dependsOn: ['1'] },
    ])
    expect(code).toContain('flowchart TD')
    expect(code).toContain('S1 --> S2')
    expect(code).toContain('S1 --> S3')
  })

  it('resolvePlanFlowchartMermaid prefers explicit mermaid over synthesis', () => {
    const r = resolvePlanFlowchartMermaid('flowchart TD\n    A --> B', [{ ref: '1', dependsOn: ['2'] }])
    expect(r.synthesized).toBe(false)
    expect(r.code).toContain('A --> B')
  })

  it('resolvePlanFlowchartMermaid synthesizes when explicit missing', () => {
    const r = resolvePlanFlowchartMermaid('', [
      { ref: '1', shortName: 'a' },
      { ref: '2', shortName: 'b', dependsOn: ['1'] },
    ])
    expect(r.synthesized).toBe(true)
    expect(r.code).toContain('S1 --> S2')
  })

  it('pickRicherStructuredPlanInput keeps flowchart from the other source', () => {
    const merged = pickRicherStructuredPlanInput(
      {
        goal: '目标',
        steps: [{ name: 's1' }, { name: 's2' }, { name: 's3' }],
        flowchartMermaid: '',
      },
      {
        goal: '目标',
        steps: [{ name: 's1' }, { name: 's2' }],
        flowchartMermaid: 'flowchart TD\n    S1 --> S2',
      },
    )
    expect(merged.flowchartMermaid).toContain('S1 --> S2')
    expect(merged.steps).toHaveLength(3)
  })
})
