import { flowchartMermaidFromSteps } from './parse-plan-markdown.js'
import type { AppCanvasJson } from './app-workflow-canvas-json.js'
import { ANSWER_NODE_ID } from './app-workflow-flow.js'
import { joinCsvField, parseCsvField } from './workflow-step-csv.js'

export type OutputSchemaFieldType = 'string' | 'number' | 'boolean' | 'object' | 'array'

/** Simplified output schema field for UI editing (maps to JSON Schema properties). */
export type OutputSchemaField = {
  name: string
  type: OutputSchemaFieldType
  description?: string
  required?: boolean
}

/** Output schema definition (UI form; serialized as JSON Schema on export). */
export type OutputSchemaDef = {
  fields: OutputSchemaField[]
}

/** Input schema definition (UI form; serialized as JSON Schema on export). */
export type InputSchemaDef = {
  fields: OutputSchemaField[]
}

export type AppWorkflowStep = {
  ref: string
  name: string
  description: string
  goal?: string
  inputs?: string
  outputs?: string
  acceptance?: string
  failure?: string
  instruction?: string
  tools?: string
  skills?: string
  mcp_servers?: string
  model?: string
  project_path?: string
  assigned_agent?: string
  depends_on: string[]
  /** Input bindings: variable name -> expression (e.g. {{steps.1.output.companies}}). */
  input_bindings?: Record<string, string>
  /** Input schema: declares expected types for input_bindings values (type contract). */
  input_schema?: InputSchemaDef
  /** Per-step schema enforcement override: '' | 'strict' | 'warn' | 'ignore'. Empty = use app-level default. */
  schema_enforcement?: '' | 'strict' | 'warn' | 'ignore'
  /** Output schema: declares structured output fields for downstream binding. */
  output_schema?: OutputSchemaDef
  /** @deprecated layout lives in AppWorkflowPlan.canvas; kept for load-compat */
  canvas?: { x: number; y: number }
}

export type StepFieldDef = {
  key: keyof AppWorkflowStep
  label: string
  multiline?: boolean
  placeholder?: string
}

/** 与 plan 模式 / PlanStepInput 对齐的可编辑字段（步骤名称由连线顺序自动生成，不在 UI 编辑） */
export const STEP_INSPECTOR_FIELDS: StepFieldDef[] = [
  { key: 'description', label: '描述', multiline: true, placeholder: '补充备注' },
  { key: 'goal', label: '步骤说明', multiline: true, placeholder: '这一步要完成什么' },
  { key: 'assigned_agent', label: '执行 Agent', placeholder: 'agent_code' },
  {
    key: 'inputs',
    label: '输入说明（给本步 Agent）',
    multiline: true,
    placeholder: '需要本步 Agent 知道的上下文要点；连线后上游报告也会自动注入',
  },
  {
    key: 'outputs',
    label: '期望产出（文件或结果要点）',
    multiline: true,
    placeholder: '希望交付的文件路径或结果要点，供后续步骤与验收参考',
  },
  { key: 'acceptance', label: '验收标准', multiline: true },
  { key: 'failure', label: '失败处理', multiline: true },
  { key: 'instruction', label: '补充指令', multiline: true },
  { key: 'tools', label: '工具', placeholder: '逗号分隔，如 read_file,write_file' },
  { key: 'skills', label: '技能', placeholder: '逗号分隔' },
  { key: 'model', label: '模型', placeholder: '可选模型覆盖' },
  { key: 'project_path', label: '工作目录', placeholder: '可选项目路径' },
]

export type StepInspectorGroup = {
  id: string
  label: string
  keys: (keyof AppWorkflowStep)[]
}

export const STEP_INSPECTOR_GROUPS: StepInspectorGroup[] = [
  {
    id: 'basic',
    label: '基础配置',
    keys: ['description', 'goal', 'assigned_agent'],
  },
  {
    id: 'io',
    label: '输入输出',
    keys: ['inputs', 'outputs', 'acceptance', 'failure'],
  },
  {
    id: 'exec',
    label: '执行配置',
    keys: ['instruction', 'tools', 'skills', 'model', 'project_path'],
  },
]

export const STEP_FIELD_MAP = Object.fromEntries(
  STEP_INSPECTOR_FIELDS.map((f) => [f.key, f]),
) as Record<keyof AppWorkflowStep, StepFieldDef | undefined>

export type AppWorkflowPlan = {
  goal: string
  steps: AppWorkflowStep[]
  flowchart_mermaid: string
  /** Dual-track visual layout (nodes / edges / viewport). Runner ignores this. */
  canvas?: AppCanvasJson
  /** Step ref whose result is the public OpenAPI / 运行页 answer (answer node). */
  answer_from_ref?: string
}

const NODE_W = 300
const NODE_GAP = 48
const NODE_ROW = 168
const START_OFFSET_X = 300

export function defaultNodePosition(index: number) {
  const col = index % 3
  const row = Math.floor(index / 3)
  return { x: START_OFFSET_X + col * (NODE_W + NODE_GAP), y: 80 + row * NODE_ROW }
}

/**
 * 按 depends_on 分层布局：深度从左到右，同层上下铺开，避免全挤在同一横线。
 */
export function layoutStepsByDependsOn(
  steps: Array<{ ref: string; depends_on?: string[] }>,
): Map<string, { x: number; y: number }> {
  const refSet = new Set(steps.map((s) => s.ref))
  const depth = new Map<string, number>()

  const getDepth = (ref: string, stack: Set<string>): number => {
    if (depth.has(ref)) return depth.get(ref) as number
    if (stack.has(ref)) return 0
    stack.add(ref)
    const step = steps.find((s) => s.ref === ref)
    const deps = (step?.depends_on || []).filter((d) => refSet.has(d))
    const d = deps.length ? Math.max(...deps.map((dep) => getDepth(dep, stack))) + 1 : 0
    depth.set(ref, d)
    stack.delete(ref)
    return d
  }

  for (const s of steps) getDepth(s.ref, new Set())

  const byLevel = new Map<number, string[]>()
  for (const s of steps) {
    const lv = depth.get(s.ref) ?? 0
    if (!byLevel.has(lv)) byLevel.set(lv, [])
    byLevel.get(lv)!.push(s.ref)
  }

  const colW = NODE_W + NODE_GAP
  const out = new Map<string, { x: number; y: number }>()
  const levels = [...byLevel.keys()].sort((a, b) => a - b)
  for (const lv of levels) {
    const list = byLevel.get(lv) || []
    list.forEach((ref, i) => {
      out.set(ref, {
        x: START_OFFSET_X + lv * colW,
        y: 80 + i * NODE_ROW,
      })
    })
  }
  return out
}

/** 所有步骤节点几乎同一水平线时视为布局未初始化好 */
export function isFlatStepLayout(positions: Array<{ y: number }>): boolean {
  if (positions.length < 2) return false
  let minY = Infinity
  let maxY = -Infinity
  for (const p of positions) {
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  return maxY - minY < 48
}

export function nextStepRef(steps: Array<{ ref?: string | number }>) {
  let max = 0
  for (let i = 0; i < steps.length; i++) {
    const n = parseInt(String(steps[i].ref ?? i + 1), 10)
    if (!Number.isNaN(n)) max = Math.max(max, n)
  }
  return String(max + 1)
}

function pickStr(v: unknown) {
  return v != null ? String(v).trim() : ''
}

/** API may return tools/skills as string[] or CSV string; UI keeps CSV on the step model. */
function fieldToUiCsv(v: unknown): string | undefined {
  if (Array.isArray(v)) return joinCsvField(v.map((x) => String(x)))
  return pickStr(v) || undefined
}

function parseInputBindings(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    const ks = String(k).trim()
    const vs = String(v ?? '').trim()
    if (ks && vs) out[ks] = vs
  }
  return Object.keys(out).length ? out : undefined
}

function parseOutputSchema(raw: unknown): OutputSchemaDef | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const schema = raw as Record<string, unknown>
  // Support both UI form ({ fields: [...] }) and JSON Schema ({ properties: {...} })
  const fields: OutputSchemaField[] = []
  if (Array.isArray(schema.fields)) {
    for (const f of schema.fields) {
      if (!f || typeof f !== 'object') continue
      const name = String((f as Record<string, unknown>).name ?? '').trim()
      if (!name) continue
      fields.push({
        name,
        type: ((f as Record<string, unknown>).type as OutputSchemaFieldType) || 'string',
        description: String((f as Record<string, unknown>).description ?? '').trim() || undefined,
        required: Boolean((f as Record<string, unknown>).required),
      })
    }
  } else if (schema.properties && typeof schema.properties === 'object') {
    const props = schema.properties as Record<string, unknown>
    const requiredList = Array.isArray(schema.required) ? (schema.required as unknown[]).map(String) : []
    for (const [name, def] of Object.entries(props)) {
      if (!def || typeof def !== 'object') continue
      fields.push({
        name,
        type: ((def as Record<string, unknown>).type as OutputSchemaFieldType) || 'string',
        description: String((def as Record<string, unknown>).description ?? '').trim() || undefined,
        required: requiredList.includes(name),
      })
    }
  }
  return fields.length ? { fields } : undefined
}

function parseInputSchema(raw: unknown): InputSchemaDef | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const schema = raw as Record<string, unknown>
  // Support both UI form ({ fields: [...] }) and JSON Schema ({ properties: {...} })
  const fields: OutputSchemaField[] = []
  if (Array.isArray(schema.fields)) {
    for (const f of schema.fields) {
      if (!f || typeof f !== 'object') continue
      const name = String((f as Record<string, unknown>).name ?? '').trim()
      if (!name) continue
      fields.push({
        name,
        type: ((f as Record<string, unknown>).type as OutputSchemaFieldType) || 'string',
        description: String((f as Record<string, unknown>).description ?? '').trim() || undefined,
        required: Boolean((f as Record<string, unknown>).required),
      })
    }
  } else if (schema.properties && typeof schema.properties === 'object') {
    const props = schema.properties as Record<string, unknown>
    const requiredList = Array.isArray(schema.required) ? (schema.required as unknown[]).map(String) : []
    for (const [name, def] of Object.entries(props)) {
      if (!def || typeof def !== 'object') continue
      fields.push({
        name,
        type: ((def as Record<string, unknown>).type as OutputSchemaFieldType) || 'string',
        description: String((def as Record<string, unknown>).description ?? '').trim() || undefined,
        required: requiredList.includes(name),
      })
    }
  }
  return fields.length ? { fields } : undefined
}

function stepFromRaw(step: Record<string, unknown>, i: number): AppWorkflowStep {
  const ref = String(step.ref ?? step.step_ref ?? i + 1).trim() || String(i + 1)
  const canvas = (step.canvas as { x?: number; y?: number } | undefined) || defaultNodePosition(i)
  return {
    ref,
    name: pickStr(step.name),
    description: pickStr(step.description),
    goal: pickStr(step.goal) || undefined,
    inputs: pickStr(step.inputs) || undefined,
    outputs: pickStr(step.outputs) || undefined,
    acceptance: pickStr(step.acceptance) || undefined,
    failure: pickStr(step.failure) || undefined,
    instruction: pickStr(step.instruction) || undefined,
    tools: fieldToUiCsv(step.tools),
    skills: fieldToUiCsv(step.skills),
    mcp_servers: fieldToUiCsv(step.mcp_servers),
    model: pickStr(step.model) || undefined,
    project_path: pickStr(step.project_path ?? step.projectPath) || undefined,
    assigned_agent: pickStr(step.assigned_agent) || undefined,
    depends_on: Array.isArray(step.depends_on)
      ? step.depends_on.map((d) => String(d).trim()).filter(Boolean)
      : [],
    input_bindings: parseInputBindings(step.input_bindings),
    input_schema: parseInputSchema(step.input_schema),
    schema_enforcement: (pickStr(step.schema_enforcement) as '' | 'strict' | 'warn' | 'ignore') || '',
    output_schema: parseOutputSchema(step.output_schema),
    canvas: {
      x: canvas.x ?? defaultNodePosition(i).x,
      y: canvas.y ?? defaultNodePosition(i).y,
    },
  }
}

export function normalizeSteps(raw: Array<Record<string, unknown>> | undefined): AppWorkflowStep[] {
  return (raw || []).map((step, i) => stepFromRaw(step, i))
}

function stepOrderFromDependsOn(steps: AppWorkflowStep[]): Map<string, number> {
  const order = new Map<string, number>()
  const inDeg = new Map<string, number>()
  const adj = new Map<string, string[]>()

  for (const s of steps) {
    inDeg.set(s.ref, s.depends_on.length)
    for (const dep of s.depends_on) {
      if (!adj.has(dep)) adj.set(dep, [])
      adj.get(dep)!.push(s.ref)
    }
  }

  const queue = steps
    .filter((s) => s.depends_on.length === 0)
    .map((s) => s.ref)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  let idx = 0
  while (queue.length) {
    const ref = queue.shift()!
    if (!order.has(ref)) order.set(ref, idx++)
    for (const next of adj.get(ref) || []) {
      inDeg.set(next, (inDeg.get(next) || 1) - 1)
      if (inDeg.get(next) === 0) queue.push(next)
    }
    queue.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  }

  for (const s of steps) {
    if (!order.has(s.ref)) order.set(s.ref, order.size)
  }
  return order
}

function exportStepName(_step: AppWorkflowStep, orderIndex: number): string {
  return `步骤 ${orderIndex + 1}`
}

export function stepsToExport(
  goal: string,
  steps: AppWorkflowStep[],
  canvas?: AppCanvasJson,
): AppWorkflowPlan {
  const orderMap = stepOrderFromDependsOn(steps)
  const payload = steps.map((s) => {
    const orderIndex = orderMap.get(s.ref) ?? 0
    const row: Record<string, unknown> = {
      ref: s.ref,
      name: exportStepName(s, orderIndex),
      description: s.description,
      depends_on: [...s.depends_on],
    }
    for (const key of [
      'goal',
      'inputs',
      'outputs',
      'acceptance',
      'failure',
      'instruction',
      'model',
      'project_path',
      'assigned_agent',
    ] as const) {
      const v = s[key]
      // 空字符串也写入，表示用户显式清空了该字段（区别于"未设置"）
      if (typeof v === 'string') row[key] = v
    }
    // Persist as string[] (backend contract); UI still edits CSV on the step model
    const tools = parseCsvField(s.tools)
    const skills = parseCsvField(s.skills)
    const mcp = parseCsvField(s.mcp_servers)
    if (tools.length) row.tools = tools
    if (skills.length) row.skills = skills
    if (mcp.length) row.mcp_servers = mcp
    // Serialize input_bindings (UI form -> backend contract)
    if (s.input_bindings && Object.keys(s.input_bindings).length) {
      row.input_bindings = { ...s.input_bindings }
    }
    // Serialize output_schema (UI form -> JSON Schema for backend)
    if (s.output_schema && s.output_schema.fields.length) {
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const f of s.output_schema.fields) {
        const prop: Record<string, unknown> = { type: f.type }
        if (f.description) prop.description = f.description
        properties[f.name] = prop
        if (f.required) required.push(f.name)
      }
      row.output_schema = {
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
      }
    }
    // Serialize input_schema (UI form -> JSON Schema for backend)
    if (s.input_schema && s.input_schema.fields.length) {
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const f of s.input_schema.fields) {
        const prop: Record<string, unknown> = { type: f.type }
        if (f.description) prop.description = f.description
        properties[f.name] = prop
        if (f.required) required.push(f.name)
      }
      row.input_schema = {
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
      }
    }
    if (s.schema_enforcement) {
      row.schema_enforcement = s.schema_enforcement
    }
    return row
  })
  const plan: AppWorkflowPlan = {
    goal: goal.trim(),
    steps: payload as AppWorkflowStep[],
    flowchart_mermaid: flowchartMermaidFromSteps(payload),
  }
  if (canvas) {
    plan.canvas = canvas
    const edge = (canvas.edges || []).find((e) => e.target === ANSWER_NODE_ID)
    const ref = edge?.source ? String(edge.source) : ''
    if (ref && ref !== ANSWER_NODE_ID) plan.answer_from_ref = ref
    else plan.answer_from_ref = ''
  }
  return plan
}

export function wouldCreateCycle(
  edges: Array<{ source: string; target: string }>,
  source: string,
  target: string,
): boolean {
  if (source === target) return true
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, [])
    adj.get(e.source)!.push(e.target)
  }
  if (!adj.has(source)) adj.set(source, [])
  adj.get(source)!.push(target)

  const visited = new Set<string>()
  const stack = [target]
  while (stack.length) {
    const cur = stack.pop()!
    if (cur === source) return true
    if (visited.has(cur)) continue
    visited.add(cur)
    for (const next of adj.get(cur) || []) stack.push(next)
  }
  return false
}

export type StepNodeData = AppWorkflowStep & { depCount?: number }

export function stepToNodeData(step: AppWorkflowStep): StepNodeData {
  return { ...step, depCount: step.depends_on.length }
}

export function nodeDataToStep(data: StepNodeData, position: { x: number; y: number }, depends_on: string[]): AppWorkflowStep {
  const { depCount: _dc, ...rest } = data
  return {
    ...rest,
    depends_on,
    canvas: { x: position.x, y: position.y },
  }
}
