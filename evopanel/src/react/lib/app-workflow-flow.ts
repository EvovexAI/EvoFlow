import { type Edge, type Node } from '@xyflow/react'
import {
  defaultNodePosition,
  nodeDataToStep,
  stepToNodeData,
  type AppWorkflowStep,
  type StepNodeData,
} from './app-workflow-plan.js'

export const START_NODE_ID = '__start__'
export const ANSWER_NODE_ID = '__answer__'

const STEP_EDGE_STYLE = { stroke: 'var(--wf-edge)', strokeWidth: 1.5 }
const START_EDGE_STYLE = { stroke: 'var(--wf-edge)', strokeWidth: 1.5 }

function stepEdge(source: string, target: string): Edge {
  return {
    id: `${source}->${target}`,
    source,
    sourceHandle: 'out',
    target,
    targetHandle: 'in',
    type: 'wfEdge',
    style: STEP_EDGE_STYLE,
  }
}

function startEdge(target: string): Edge {
  return {
    id: `${START_NODE_ID}->${target}`,
    source: START_NODE_ID,
    sourceHandle: 'out',
    target,
    targetHandle: 'in',
    type: 'wfEdge',
    animated: true,
    style: START_EDGE_STYLE,
  }
}

export function createStartNode(): Node {
  return {
    id: START_NODE_ID,
    type: 'startNode',
    position: { x: 48, y: 140 },
    data: {},
    deletable: false,
  }
}

export function createAnswerNode(position?: { x: number; y: number }, sourceRef = ''): Node {
  return {
    id: ANSWER_NODE_ID,
    type: 'answerNode',
    position: position || { x: 720, y: 140 },
    data: { sourceRef },
    deletable: true,
  }
}

export function realEdges(edges: Edge[]) {
  return edges.filter((e) => e.source !== START_NODE_ID)
}

/** Step↔step edges only (excludes start / answer sink). */
export function stepDependencyEdges(edges: Edge[]) {
  return edges.filter(
    (e) =>
      e.source !== START_NODE_ID &&
      e.source !== ANSWER_NODE_ID &&
      e.target !== START_NODE_ID &&
      e.target !== ANSWER_NODE_ID,
  )
}

export function answerFromRefFromEdges(edges: Edge[]): string {
  const hit = edges.find((e) => e.target === ANSWER_NODE_ID && e.source && e.source !== START_NODE_ID)
  return hit?.source ? String(hit.source) : ''
}

export function enrichNodesWithDepCount(nodes: Node<StepNodeData>[], edges: Edge[]) {
  const deps = stepDependencyEdges(edges)
  const answerRef = answerFromRefFromEdges(edges)
  return nodes.map((n) => {
    if (n.type === 'answerNode') {
      return { ...n, data: { ...(n.data || {}), sourceRef: answerRef } }
    }
    if (n.type !== 'stepNode') return n
    const depCount = deps.filter((e) => e.target === n.id).length
    return { ...n, data: { ...n.data, depCount } }
  })
}

/** 从 steps.depends_on 生成业务连线（不含开始节点）。 */
export function edgesFromDependsOn(steps: AppWorkflowStep[]): Edge[] {
  const refs = new Set(steps.map((s) => s.ref))
  const out: Edge[] = []
  const seen = new Set<string>()
  for (const step of steps) {
    for (const dep of step.depends_on || []) {
      if (!dep || dep === step.ref || !refs.has(dep)) continue
      const id = `${dep}->${step.ref}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push(stepEdge(dep, step.ref))
    }
  }
  return out
}

export function reconcileStartEdges(edges: Edge[], nodes: Node[]) {
  const stepIds = new Set(nodes.filter((n) => n.type === 'stepNode').map((n) => n.id))
  const hasAnswer = nodes.some((n) => n.id === ANSWER_NODE_ID || n.type === 'answerNode')
  const real = realEdges(edges)
  // Step↔step + step→answer; drop dangling
  const validReal = real.filter((e) => {
    if (!stepIds.has(e.source)) return false
    if (stepIds.has(e.target)) return true
    return hasAnswer && e.target === ANSWER_NODE_ID
  })
  // At most one answer inbound
  const answerIns = validReal.filter((e) => e.target === ANSWER_NODE_ID)
  const withoutAnswer = validReal.filter((e) => e.target !== ANSWER_NODE_ID)
  const answerKeep = answerIns.length ? [answerIns[answerIns.length - 1]] : []
  const stepReal = [...withoutAnswer, ...answerKeep]
  const withIncoming = new Set(
    stepReal.filter((e) => stepIds.has(e.target)).map((e) => e.target),
  )
  const autoStart = [...stepIds]
    .filter((id) => !withIncoming.has(id))
    .map((id) => startEdge(id))
  return [...stepReal, ...autoStart]
}

export function reconcileFlowGraph(nodes: Node<StepNodeData>[], edges: Edge[]) {
  const nextEdges = reconcileStartEdges(edges, nodes)
  const nextNodes = enrichNodesWithDepCount(nodes, nextEdges)
  return { nodes: nextNodes, edges: nextEdges }
}

export function stepsToFlow(steps: AppWorkflowStep[]) {
  const stepNodes: Node<StepNodeData>[] = steps.map((step, i) => ({
    id: step.ref,
    type: 'stepNode',
    position: step.canvas || defaultNodePosition(i),
    data: stepToNodeData(step),
  }))

  const depEdges: Edge[] = []
  for (const step of steps) {
    for (const dep of step.depends_on) {
      if (dep === step.ref) continue
      depEdges.push(stepEdge(dep, step.ref))
    }
  }

  const nodes: Node<StepNodeData>[] = [createStartNode() as Node<StepNodeData>, ...stepNodes]
  const edges = reconcileStartEdges(depEdges, nodes)
  return reconcileFlowGraph(nodes, edges)
}

export function flowToSteps(nodes: Node<StepNodeData>[], edges: Edge[]): AppWorkflowStep[] {
  const real = stepDependencyEdges(edges)
  return nodes
    .filter((n) => n.type === 'stepNode')
    .map((n) =>
      nodeDataToStep(
        n.data,
        { x: n.position.x, y: n.position.y },
        real.filter((e) => e.target === n.id).map((e) => e.source),
      ),
    )
}

export function applyFlowPatch(
  nodes: Node<StepNodeData>[],
  edges: Edge[],
  patch: { nodes?: Node<StepNodeData>[]; edges?: Edge[] },
) {
  const nextNodes = patch.nodes ?? nodes
  const nextEdges = patch.edges ?? edges
  return reconcileFlowGraph(nextNodes, nextEdges)
}
