import { type Edge, type Node, type Viewport } from '@xyflow/react'
import {
  defaultNodePosition,
  isFlatStepLayout,
  layoutStepsByDependsOn,
  stepToNodeData,
  type AppWorkflowStep,
  type StepNodeData,
} from './app-workflow-plan.js'
import {
  ANSWER_NODE_ID,
  START_NODE_ID,
  createAnswerNode,
  createStartNode,
  edgesFromDependsOn,
  enrichNodesWithDepCount,
  reconcileStartEdges,
  realEdges,
} from './app-workflow-flow.js'

export type AppCanvasNodeType = 'start' | 'agentStep' | 'answer'

export type AppCanvasNode = {
  nodeId: string
  type: AppCanvasNodeType
  position: { x: number; y: number }
}

export type AppCanvasEdge = {
  source: string
  target: string
  sourceHandle: string
  targetHandle: string
}

export type AppCanvasJson = {
  nodes: AppCanvasNode[]
  edges: AppCanvasEdge[]
  viewport?: { x: number; y: number; zoom: number }
}

const STEP_EDGE_STYLE = { stroke: 'var(--wf-edge)', strokeWidth: 1.5 }
const START_EDGE_STYLE = { stroke: 'var(--wf-edge)', strokeWidth: 1.5 }

function isCanvasJson(raw: unknown): raw is AppCanvasJson {
  return (
    !!raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as AppCanvasJson).nodes) &&
    (raw as AppCanvasJson).nodes.length > 0
  )
}

/** Build canvas layout from legacy step.canvas + depends_on. */
export function migrateStepsToCanvas(steps: AppWorkflowStep[]): AppCanvasJson {
  const nodes: AppCanvasNode[] = [
    {
      nodeId: START_NODE_ID,
      type: 'start',
      position: { x: 48, y: 140 },
    },
  ]
  const edges: AppCanvasEdge[] = []
  const autoPos = layoutStepsByDependsOn(steps)
  const legacyPos = steps
    .map((s) => s.canvas)
    .filter((p): p is { x: number; y: number } => !!p)
  const useLegacy = legacyPos.length === steps.length && !isFlatStepLayout(legacyPos)

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const pos =
      (useLegacy && step.canvas) ||
      autoPos.get(step.ref) ||
      defaultNodePosition(i)
    nodes.push({
      nodeId: step.ref,
      type: 'agentStep',
      position: { x: pos.x, y: pos.y },
    })
    for (const dep of step.depends_on) {
      if (!dep || dep === step.ref) continue
      edges.push({
        source: dep,
        target: step.ref,
        sourceHandle: 'out',
        targetHandle: 'in',
      })
    }
  }

  const withIncoming = new Set(edges.map((e) => e.target))
  for (const n of nodes) {
    if (n.type !== 'agentStep') continue
    if (!withIncoming.has(n.nodeId)) {
      edges.push({
        source: START_NODE_ID,
        target: n.nodeId,
        sourceHandle: 'out',
        targetHandle: 'in',
      })
    }
  }

  return { nodes, edges }
}

export function flowToCanvasJson(
  nodes: Node<StepNodeData>[],
  edges: Edge[],
  viewport?: Viewport | null,
): AppCanvasJson {
  const canvasNodes: AppCanvasNode[] = nodes
    .filter((n) => n.type === 'startNode' || n.type === 'stepNode' || n.type === 'answerNode')
    .map((n) => ({
      nodeId: n.type === 'answerNode' ? ANSWER_NODE_ID : n.id,
      type: (n.type === 'startNode'
        ? 'start'
        : n.type === 'answerNode'
          ? 'answer'
          : 'agentStep') as AppCanvasNodeType,
      position: { x: n.position.x, y: n.position.y },
    }))

  // Ensure start exists even if filtered oddly
  if (!canvasNodes.some((n) => n.nodeId === START_NODE_ID)) {
    canvasNodes.unshift({
      nodeId: START_NODE_ID,
      type: 'start',
      position: { x: 48, y: 140 },
    })
  }

  const canvasEdges: AppCanvasEdge[] = edges.map((e) => ({
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle || 'out',
    targetHandle: e.targetHandle || 'in',
  }))

  const out: AppCanvasJson = { nodes: canvasNodes, edges: canvasEdges }
  if (viewport && Number.isFinite(viewport.zoom)) {
    out.viewport = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
  }
  return out
}

/**
 * Build React Flow seed from canvas_json + step semantics.
 * If canvas is missing/empty, falls back to migrateStepsToCanvas(steps).
 */
export function canvasJsonToFlowSeed(
  steps: AppWorkflowStep[],
  canvas: AppCanvasJson | null | undefined,
): { nodes: Node<StepNodeData>[]; edges: Edge[]; viewport?: Viewport } {
  const layout = isCanvasJson(canvas) ? canvas : migrateStepsToCanvas(steps)
  const stepByRef = new Map(steps.map((s) => [s.ref, s]))

  const nodes: Node<StepNodeData>[] = []
  for (const cn of layout.nodes) {
    if (cn.type === 'start' || cn.nodeId === START_NODE_ID) {
      const start = createStartNode()
      start.position = {
        x: cn.position?.x ?? 48,
        y: cn.position?.y ?? 140,
      }
      nodes.push(start as Node<StepNodeData>)
      continue
    }
    if (cn.type === 'answer' || cn.nodeId === ANSWER_NODE_ID) {
      const answer = createAnswerNode({
        x: cn.position?.x ?? 720,
        y: cn.position?.y ?? 140,
      })
      nodes.push(answer as Node<StepNodeData>)
      continue
    }
    const step = stepByRef.get(cn.nodeId)
    const base: AppWorkflowStep = step || {
      ref: cn.nodeId,
      name: '',
      description: '',
      depends_on: [],
    }
    nodes.push({
      id: cn.nodeId,
      type: 'stepNode',
      position: {
        x: cn.position?.x ?? defaultNodePosition(nodes.length).x,
        y: cn.position?.y ?? defaultNodePosition(nodes.length).y,
      },
      data: stepToNodeData({ ...base, canvas: undefined }),
    })
  }

  // Steps present in data but missing from canvas layout
  const laidOut = new Set(nodes.map((n) => n.id))
  const missing = steps.filter((s) => !laidOut.has(s.ref))
  if (missing.length) {
    const autoPos = layoutStepsByDependsOn(steps)
    for (const step of missing) {
      nodes.push({
        id: step.ref,
        type: 'stepNode',
        position: autoPos.get(step.ref) || step.canvas || defaultNodePosition(nodes.length),
        data: stepToNodeData({ ...step, canvas: undefined }),
      })
    }
  }

  if (!nodes.some((n) => n.id === START_NODE_ID)) {
    nodes.unshift(createStartNode() as Node<StepNodeData>)
  }

  // 打开后发现步骤挤在同一横线：按依赖重新分层布局
  const stepNodes = nodes.filter((n) => n.type === 'stepNode')
  const didAutoLayout =
    steps.length >= 2 && isFlatStepLayout(stepNodes.map((n) => n.position))
  if (didAutoLayout) {
    const autoPos = layoutStepsByDependsOn(steps)
    for (const n of nodes) {
      if (n.type !== 'stepNode') continue
      const p = autoPos.get(n.id)
      if (p) n.position = { x: p.x, y: p.y }
    }
    // 开始节点对齐到第 0 层中线，连线更顺
    const start = nodes.find((n) => n.id === START_NODE_ID)
    const level0 = steps
      .filter((s) => !(s.depends_on || []).some((d) => steps.some((x) => x.ref === d)))
      .map((s) => autoPos.get(s.ref))
      .filter((p): p is { x: number; y: number } => !!p)
    if (start && level0.length) {
      const avgY = level0.reduce((sum, p) => sum + p.y, 0) / level0.length
      start.position = { x: start.position.x || 48, y: avgY }
    }
  }

  const storedEdges: Edge[] = (layout.edges || [])
    .filter((e) => e.source && e.target)
    .map((e) => {
      const isStart = e.source === START_NODE_ID
      return {
        id: `${e.source}->${e.target}`,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle || 'out',
        targetHandle: e.targetHandle || 'in',
        type: 'wfEdge',
        animated: isStart,
        style: isStart ? START_EDGE_STYLE : STEP_EDGE_STYLE,
      }
    })

  // 业务连线以 steps.depends_on 为准；canvas 边仅作 depends_on 为空时的兜底
  // answer 边始终从 canvas 恢复（不进 depends_on）
  const fromDeps = edgesFromDependsOn(steps)
  const fromCanvas = realEdges(storedEdges)
  const answerEdges = fromCanvas.filter((e) => e.target === ANSWER_NODE_ID)
  const edges = reconcileStartEdges(
    [...(fromDeps.length ? fromDeps : fromCanvas.filter((e) => e.target !== ANSWER_NODE_ID)), ...answerEdges],
    nodes,
  )
  const enriched = enrichNodesWithDepCount(nodes, edges)

  const result: {
    nodes: Node<StepNodeData>[]
    edges: Edge[]
    viewport?: Viewport
  } = { nodes: enriched, edges }

  if (layout.viewport && Number.isFinite(layout.viewport.zoom)) {
    result.viewport = {
      x: layout.viewport.x,
      y: layout.viewport.y,
      zoom: layout.viewport.zoom,
    }
  }
  return result
}

/** Strip nested canvas from steps for dual-track storage. */
export function stripStepCanvas(steps: AppWorkflowStep[]): AppWorkflowStep[] {
  return steps.map((s) => {
    const { canvas: _c, ...rest } = s
    return { ...rest, depends_on: [...s.depends_on] }
  })
}

export function normalizeCanvasRaw(raw: unknown): AppCanvasJson | null {
  if (!isCanvasJson(raw)) return null
  return {
    nodes: (raw.nodes || []).map((n) => ({
      nodeId: String(n.nodeId || ''),
      type:
        n.type === 'start' || n.nodeId === START_NODE_ID
          ? 'start'
          : n.type === 'answer' || n.nodeId === ANSWER_NODE_ID
            ? 'answer'
            : 'agentStep',
      position: {
        x: Number(n.position?.x) || 0,
        y: Number(n.position?.y) || 0,
      },
    })),
    edges: (raw.edges || []).map((e) => ({
      source: String(e.source || ''),
      target: String(e.target || ''),
      sourceHandle: String(e.sourceHandle || 'out'),
      targetHandle: String(e.targetHandle || 'in'),
    })),
    viewport: raw.viewport
      ? {
          x: Number(raw.viewport.x) || 0,
          y: Number(raw.viewport.y) || 0,
          zoom: Number(raw.viewport.zoom) || 1,
        }
      : undefined,
  }
}
