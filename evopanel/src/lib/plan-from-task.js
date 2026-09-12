/** Normalize structured plan fields from GET /api/tasks row. */

import { getToolInputObjectFromRow } from './chat-normalize.js'
import { looksLikePlanToolArgs } from './plan-tool-shape.js'

export { looksLikePlanToolArgs } from './plan-tool-shape.js'

/**
 * @param {unknown} raw
 * @returns {string}
 */
function formatListValue(raw) {
  if (raw == null) return ''
  if (Array.isArray(raw)) {
    return raw
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .join(', ')
  }
  const text = String(raw).trim()
  if (!text) return ''
  if (text.startsWith('[')) {
    try {
      const loaded = JSON.parse(text)
      if (Array.isArray(loaded)) return formatListValue(loaded)
    } catch {
      /* keep text */
    }
  }
  return text
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function formatWorkChecklist(raw) {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw.trim()
  if (!Array.isArray(raw)) return ''
  return raw
    .map((item, i) => {
      if (typeof item === 'string') return `${i + 1}. ${item.trim()}`
      if (item && typeof item === 'object') {
        const title = String(item.title || item.name || item.text || item.label || '').trim()
        const status = String(item.status || '').trim()
        if (title && status) return `${i + 1}. ${title} [${status}]`
        if (title) return `${i + 1}. ${title}`
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** @type {Record<string, string>} */
const REQUIREMENT_LABEL_TO_KEY = {
  目标: 'goal',
  输入物: 'inputs',
  输出物: 'outputs',
  验收标准: 'acceptance',
  失败处理: 'failure',
}

/**
 * Parse subtask description built by ``build_subtask_description_from_step``.
 * @param {string} text
 */
export function parseRequirementsFromDescription(text) {
  const out = /** @type {Record<string, string>} */ ({})
  const raw = String(text || '').trim()
  if (!raw) return out
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const m = t.match(/^([^：:]+)[：:]\s*(.+)$/)
    if (!m) continue
    const label = m[1].trim()
    const key = REQUIREMENT_LABEL_TO_KEY[label]
    if (key) out[key] = m[2].trim()
  }
  return out
}

/**
 * @param {Array<Record<string, unknown>>} subtasks
 * @param {string} ref
 * @param {string} name
 */
function findSubtaskForPlanStep(subtasks, ref, name) {
  const list = Array.isArray(subtasks) ? subtasks : []
  const r = String(ref || '').trim()
  const nm = String(name || '').trim()
  for (const st of list) {
    if (!st || typeof st !== 'object') continue
    const sid = String(st.id || st.subtask_id || st.subtaskId || '').trim()
    const sname = String(st.name || '').trim()
    if (r && (sid.endsWith(`_${r}`) || new RegExp(`Step\\s+${r}\\s*:`).test(sname))) return st
    if (nm && sname === nm) return st
  }
  return null
}

/**
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {string}
 */
function assigneeDisplayFromRow(row) {
  if (!row || typeof row !== 'object') return ''
  const r = /** @type {Record<string, unknown>} */ (row)
  return String(
    r.assigneeDisplay ||
      r.assignee_display ||
      r.assigned_agent_name ||
      r.assignedAgentName ||
      r.assignedAgentDisplay ||
      '',
  ).trim()
}

/**
 * @param {Record<string, unknown>} stepObj
 * @param {Record<string, unknown> | null | undefined} subtask
 */
function mergeStepWithSubtask(stepObj, subtask) {
  const merged = { ...stepObj }
  if (!subtask) return merged
  const fromDesc = parseRequirementsFromDescription(
    String(subtask.description || subtask.desc || ''),
  )
  for (const [key, val] of Object.entries(fromDesc)) {
    if (val && !String(merged[key] || '').trim()) merged[key] = val
  }
  const wp = subtask.worker_profile || subtask.workerProfile
  if (wp && typeof wp === 'object') {
    const w = /** @type {Record<string, unknown>} */ (wp)
    if (!String(merged.instruction || '').trim() && w.instruction) merged.instruction = w.instruction
    if (!formatListValue(merged.tools) && w.tools) merged.tools = w.tools
    if (!formatListValue(merged.skills) && w.skills) merged.skills = w.skills
    if (!String(merged.model || '').trim() && w.model) merged.model = w.model
  }
  if (!String(merged.assigned_agent || merged.assignee || '').trim()) {
    const a = subtask.assigned_to || subtask.assignedTo || subtask.assigned_agent
    if (a) merged.assigned_agent = a
  }
  if (!String(merged.project_path || '').trim() && subtask.project_path) {
    merged.project_path = subtask.project_path
  }
  return merged
}

/**
 * @param {Record<string, unknown>} st
 * @param {string} name
 * @returns {import('./parse-plan-markdown.js').PlanStepField[]}
 */
function buildStepFields(st, name) {
  /** @type {Array<{ key: string; label: string; value: string }>} */
  const specs = [
    { key: 'description', label: '描述', value: String(st.description || '').trim() },
    { key: 'goal', label: '目标', value: String(st.goal || '').trim() },
    { key: 'inputs', label: '输入物', value: String(st.inputs || '').trim() },
    { key: 'outputs', label: '输出物', value: String(st.outputs || '').trim() },
    { key: 'acceptance', label: '验收标准', value: String(st.acceptance || '').trim() },
    { key: 'failure', label: '失败处理', value: String(st.failure || '').trim() },
    { key: 'instruction', label: '执行指令', value: String(st.instruction || '').trim() },
    { key: 'tools', label: '工具', value: formatListValue(st.tools) },
    { key: 'skills', label: '技能', value: formatListValue(st.skills) },
    { key: 'model', label: '模型', value: String(st.model || '').trim() },
    { key: 'project_path', label: '工作目录', value: String(st.project_path || st.projectPath || '').trim() },
    { key: 'work_checklist', label: '工作清单', value: formatWorkChecklist(st.work_checklist || st.workChecklist) },
  ]
  return specs.filter((f) => {
    if (!f.value) return false
    if (f.key === 'goal' && f.value === name) return false
    return true
  })
}

/**
 * @param {unknown} st
 */
export function isParsedPlanStep(st) {
  return (
    !!st &&
    typeof st === 'object' &&
    Array.isArray(/** @type {{ fields?: unknown[] }} */ (st).fields) &&
    ('shortName' in st || 'short_name' in st || 'displayName' in st)
  )
}

/**
 * @param {unknown} raw
 * @param {number} idx
 */
function stepRefFromRaw(raw, idx) {
  const r = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const candidate = r.ref ?? r.step_num
  if (candidate != null) {
    const text = String(candidate).trim()
    if (text && text.toLowerCase() !== 'null') return text
  }
  return String(idx + 1)
}

/**
 * @param {unknown} validation
 * @returns {string[]}
 */
function normalizePlanValidation(validation) {
  if (Array.isArray(validation)) {
    return validation.map((x) => String(x || '').trim()).filter(Boolean)
  }
  if (typeof validation === 'string') {
    const t = validation.trim()
    if (!t) return []
    if (t.startsWith('[')) {
      try {
        const loaded = JSON.parse(t)
        if (Array.isArray(loaded)) return normalizePlanValidation(loaded)
      } catch {
        /* keep text */
      }
    }
    return [t]
  }
  return []
}

/**
 * Modal / dock payload: already-parsed steps (with `fields`) or raw plan_steps from API.
 * @param {Record<string, unknown> | null | undefined} input
 * @returns {import('../react/lib/parse-plan-markdown.js').ParsedPlan | null}
 */
export function planViewFromStructuredInput(input) {
  if (!input || typeof input !== 'object') return null
  const goal = String(input.goal || input.plan_goal || input.planGoal || '').trim()
  const steps = input.steps
  if (Array.isArray(steps) && steps.length && isParsedPlanStep(steps[0])) {
    if (!goal) return null
    return {
      goal,
      flowchartMermaid: String(
        input.flowchartMermaid || input.plan_flowchart_mermaid || input.planFlowchartMermaid || '',
      ).trim(),
      steps,
      validation: normalizePlanValidation(input.validation ?? input.plan_validation),
      openQuestions:
        String(input.openQuestions || input.plan_open_questions || input.planOpenQuestions || '无').trim() ||
        '无',
    }
  }
  return structuredPlanFromTask({
    plan_goal: goal,
    plan_steps: steps,
    plan_flowchart_mermaid:
      input.flowchartMermaid || input.plan_flowchart_mermaid || input.planFlowchartMermaid,
    plan_validation: input.validation ?? input.plan_validation,
    plan_open_questions: input.openQuestions || input.plan_open_questions || input.planOpenQuestions,
    subtasks: input.subtasks || input.subTasks,
  })
}

/**
 * @param {Record<string, unknown> | null | undefined} task
 * @returns {import('../react/lib/parse-plan-markdown.js').ParsedPlan | null}
 */
export function structuredPlanFromTask(task) {
  if (!task || typeof task !== 'object') return null
  const goal = String(task.plan_goal || task.planGoal || '').trim()
  let steps = task.plan_steps || task.planSteps
  if (typeof steps === 'string' && steps.trim().startsWith('[')) {
    try {
      steps = JSON.parse(steps)
    } catch {
      steps = null
    }
  }
  if (!Array.isArray(steps)) {
    const raw = task.plan_steps_json || task.planStepsJson
    if (typeof raw === 'string' && raw.trim().startsWith('[')) {
      try {
        steps = JSON.parse(raw)
      } catch {
        steps = null
      }
    }
  }
  const stepList = Array.isArray(steps) ? steps.filter((s) => s && typeof s === 'object') : []
  if (!goal || !stepList.length) return null

  let validation = task.plan_validation || task.planValidation
  if (!Array.isArray(validation)) {
    const vj = task.plan_validation_json || task.planValidationJson
    if (typeof vj === 'string' && vj.trim()) validation = vj
  }
  const validationList = normalizePlanValidation(validation)

  const parsedSteps = stepList.map((st, idx) => {
    if (isParsedPlanStep(st)) {
      const ref = stepRefFromRaw(st, idx)
      const shortName = String(st.shortName || st.short_name || st.name || `Step ${ref}`).trim()
      const dependsOn = Array.isArray(st.dependsOn)
        ? st.dependsOn.map(String)
        : Array.isArray(st.depends_on)
          ? st.depends_on.map(String)
          : []
      const assignee = String(
        st.assignee || st.assigned_agent || st.assigned_to || st.assignedAgent || '',
      ).trim()
      const assigneeDisplay = assigneeDisplayFromRow(st)
      return {
        ref,
        shortName,
        displayName: String(st.displayName || st.display_name || shortName).trim() || shortName,
        fields: st.fields,
        assignee,
        ...(assigneeDisplay ? { assigneeDisplay } : {}),
        dependsOn,
      }
    }
    const ref = stepRefFromRaw(st, idx)
    const name = String(st.name || st.short_name || st.shortName || `Step ${ref}`).trim()
    const subtasks = task.subtasks || task.subTasks
    const sub = findSubtaskForPlanStep(
      Array.isArray(subtasks) ? subtasks : [],
      ref,
      name,
    )
    const merged = mergeStepWithSubtask(st, sub)
    const assignee = String(merged.assigned_agent || merged.assignee || '').trim()
    const assigneeDisplay = assigneeDisplayFromRow(merged) || assigneeDisplayFromRow(sub)
    const deps = merged.depends_on || merged.depends_refs
    const dependsOn = Array.isArray(deps) ? deps.map(String) : []
    return {
      ref,
      shortName: name,
      displayName: name,
      fields: buildStepFields(merged, name),
      assignee,
      ...(assigneeDisplay ? { assigneeDisplay } : {}),
      dependsOn,
    }
  })

  return {
    goal,
    flowchartMermaid: String(task.plan_flowchart_mermaid || task.planFlowchartMermaid || '').trim(),
    steps: parsedSteps,
    validation: validationList,
    openQuestions: String(task.plan_open_questions || task.planOpenQuestions || '无').trim() || '无',
  }
}

/**
 * @param {Record<string, unknown> | null | undefined} task
 */
export function taskHasStructuredPlan(task) {
  return structuredPlanFromTask(task) != null
}

function parseToolJsonObject(v) {
  if (v == null) return null
  if (typeof v === 'object') return v
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return null
    try {
      const p = JSON.parse(t)
      return typeof p === 'object' && p !== null ? p : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * 识别 plan 工具行：name / function.name / 入参或出参形状（流式里常被标成「工具」或 tool）。
 * @param {unknown} row
 */
export function toolRowIsPlanTool(row) {
  if (!row || typeof row !== 'object') return false
  const t = row
  const n = String(t.name || t.tool_name || '')
    .trim()
    .toLowerCase()
  if (n === 'plan') return true
  const fn =
    t.function && typeof t.function === 'object'
      ? String(t.function.name || '')
          .trim()
          .toLowerCase()
      : ''
  if (fn === 'plan') return true
  const input = getToolInputObjectFromRow(t)
  if (looksLikePlanToolArgs(input) || structuredPlanInputFromToolInput(input)) return true
  const output = parseToolJsonObject(
    t.output ?? (t.output_text != null ? t.output_text : null),
  )
  if (structuredPlanInputFromToolOutput(output)) return true
  if (output && typeof output === 'object' && output.plan && typeof output.plan === 'object') {
    return true
  }
  return false
}

/**
 * @param {Record<string, unknown> | null | undefined} output plan tool JSON output
 */
export function structuredPlanFromToolOutput(output) {
  if (!output || typeof output !== 'object') return null
  const plan = output.plan
  if (!plan || typeof plan !== 'object') return null
  const goal = String(plan.goal || output.goal || '').trim()
  const steps = Array.isArray(plan.steps) ? plan.steps : []
  if (!goal || !steps.length) return null
  return structuredPlanFromTask({
    plan_goal: goal,
    plan_steps: steps,
    plan_flowchart_mermaid: plan.flowchart_mermaid,
    plan_validation: plan.validation,
    plan_open_questions: plan.open_questions,
  })
}

/**
 * Tool output → UI fallback payload (raw steps for modal / dock).
 * @param {Record<string, unknown> | null | undefined} output
 */
/**
 * plan 工具入参（流式 tool_call 阶段仅有 args、尚无 ToolMessage 时用于底部条回退）。
 * @param {Record<string, unknown> | null | undefined} input
 */
/** @param {Record<string, unknown> | null | undefined} payload */
export function planStructuredStepCount(payload) {
  if (!payload || typeof payload !== 'object') return 0
  const steps = payload.steps
  return Array.isArray(steps) ? steps.length : 0
}

/**
 * 合并两份 plan 的字段（flowchart / goal 等），避免 pickRicher 只比步骤数时丢掉分析图。
 * @param {Record<string, unknown>} winner
 * @param {Record<string, unknown>} other
 */
function mergeStructuredPlanFields(winner, other) {
  if (!winner) return other ?? null
  if (!other) return winner
  const fc =
    String(winner.flowchartMermaid || winner.flowchart_mermaid || '').trim() ||
    String(other.flowchartMermaid || other.flowchart_mermaid || '').trim()
  const goal =
    String(winner.goal || '').trim() ||
    String(other.goal || '').trim()
  let validation = winner.validation
  if (!Array.isArray(validation) || !validation.length) {
    validation = other.validation
  }
  const openQuestions =
    String(winner.openQuestions || winner.open_questions || '').trim() ||
    String(other.openQuestions || other.open_questions || '无').trim() ||
    '无'
  return {
    ...winner,
    goal,
    ...(fc ? { flowchartMermaid: fc } : {}),
    validation: Array.isArray(validation) ? validation : [],
    openQuestions,
  }
}

/**
 * 在 tool input / output / API 等多源 plan 中取步骤更完整的一份（避免 summary 截断 output 盖住完整 input）。
 * @param {Record<string, unknown> | null | undefined} a
 * @param {Record<string, unknown> | null | undefined} b
 */
export function pickRicherStructuredPlanInput(a, b) {
  if (!a) return b ?? null
  if (!b) return a
  const na = planStructuredStepCount(a)
  const nb = planStructuredStepCount(b)
  let winner
  if (nb > na) winner = b
  else if (na > nb) winner = a
  else {
    const ga = String(a.goal || '').trim().length
    const gb = String(b.goal || '').trim().length
    winner = gb >= ga ? b : a
  }
  const loser = winner === a ? b : a
  return mergeStructuredPlanFields(winner, loser)
}

export function structuredPlanInputFromToolInput(input) {
  if (!input || typeof input !== 'object') return null
  const goal = String(input.goal || '').trim()
  let steps = input.steps
  if (typeof steps === 'string' && steps.trim().startsWith('[')) {
    try {
      steps = JSON.parse(steps)
    } catch {
      steps = null
    }
  }
  const stepList = Array.isArray(steps) ? steps : []
  if (!goal || !stepList.length) return null
  let validation = input.validation
  if (typeof validation === 'string' && validation.trim().startsWith('[')) {
    try {
      validation = JSON.parse(validation)
    } catch {
      validation = []
    }
  }
  return {
    goal,
    flowchartMermaid: String(input.flowchart_mermaid || input.flowchartMermaid || '').trim(),
    steps: stepList,
    validation: Array.isArray(validation) ? validation : [],
    openQuestions: String(input.open_questions || input.openQuestions || '无').trim() || '无',
  }
}

export function structuredPlanInputFromToolOutput(output) {
  if (!output || typeof output !== 'object') return null
  const plan = output.plan && typeof output.plan === 'object' ? output.plan : null
  const goal = String(plan?.goal || output.goal || '').trim()
  let steps = Array.isArray(plan?.steps) ? plan.steps : []
  if (!steps.length && Array.isArray(output.steps)) steps = output.steps
  if (!goal || !steps.length) return null
  let validation = plan.validation
  if (typeof validation === 'string') {
    try {
      validation = JSON.parse(validation)
    } catch {
      validation = []
    }
  }
  return {
    goal,
    flowchartMermaid: String(plan.flowchart_mermaid || plan.flowchartMermaid || '').trim(),
    steps,
    validation: Array.isArray(validation) ? validation : [],
    openQuestions: String(plan.open_questions || plan.openQuestions || '无').trim() || '无',
  }
}

/**
 * 合并工具行 / latch / fallback / API 等多源，供确认条与「查看计划」弹窗使用。
 * @param {...(Record<string, unknown> | import('../react/lib/parse-plan-markdown.js').ParsedPlan | null | undefined)} sources
 * @returns {import('../react/lib/parse-plan-markdown.js').ParsedPlan | null}
 */
export function resolvePlanStructuredForDock(...sources) {
  /** @type {Record<string, unknown> | null} */
  let best = null
  for (const src of sources) {
    if (!src) continue
    const view = planViewFromStructuredInput(src)
    /** @type {Record<string, unknown> | null} */
    let payload = null
    if (view) {
      payload = {
        goal: view.goal,
        flowchartMermaid: view.flowchartMermaid,
        steps: view.steps,
        validation: view.validation,
        openQuestions: view.openQuestions,
      }
    } else if (src && typeof src === 'object') {
      payload =
        structuredPlanInputFromToolInput(/** @type {Record<string, unknown>} */ (src)) ||
        structuredPlanInputFromToolOutput(/** @type {Record<string, unknown>} */ (src)) ||
        null
    }
    if (payload) best = pickRicherStructuredPlanInput(payload, best)
  }
  return best ? planViewFromStructuredInput(best) : null
}

/**
 * GET /tasks/:id 行 → planInputFallback 形状。
 * @param {Record<string, unknown> | null | undefined} task
 */
export function planInputFromTaskRow(task) {
  const parsed = structuredPlanFromTask(task)
  if (!parsed) return null
  return {
    goal: parsed.goal,
    flowchartMermaid: parsed.flowchartMermaid,
    steps: parsed.steps,
    validation: parsed.validation,
    openQuestions: parsed.openQuestions,
  }
}
