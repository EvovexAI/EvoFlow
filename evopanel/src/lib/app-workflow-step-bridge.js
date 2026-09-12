/**
 * Bridge workflow plan steps (semantic refs) with runtime run steps (numeric refs).
 * Shared by run inspect UI, history modal, and canvas debug dock.
 */
import { taskOutputsOf } from './task-summary.js'

const STEP_PREFIX_RE = /^\s*step\s+\d+\s*[:：]\s*/i
const DONE_STATUS = new Set(['completed', 'done', 'success'])

/** Strip ``Step 3: Foo`` → ``Foo``. */
export function stripRuntimeStepPrefix(name) {
  return String(name || '')
    .replace(STEP_PREFIX_RE, '')
    .trim()
}

export function runtimeStepSemanticRef(step) {
  if (!step || typeof step !== 'object') return ''
  const direct = String(step.semantic_ref || '').trim()
  if (direct) return direct
  const wp = step.worker_profile
  if (wp && typeof wp === 'object') {
    const fromWp = String(wp.semantic_ref || '').trim()
    if (fromWp) return fromWp
  }
  return ''
}

/** All ref aliases for a plan step at index ``i`` (0-based). */
export function planStepAliasRefs(step, index) {
  const refs = new Set()
  const num = String((Number(index) || 0) + 1)
  refs.add(num)
  if (!step || typeof step !== 'object') return refs
  const ref = String(step.ref ?? '').trim()
  const semantic = String(step.semantic_ref ?? '').trim()
  if (ref) refs.add(ref)
  if (semantic) refs.add(semantic)
  return refs
}

function refSortKey(ref) {
  const s = String(ref || '').trim()
  const n = parseInt(s, 10)
  if (!Number.isNaN(n) && String(n) === s) return n
  if (s === '__rollup__') return 1_000_000
  return 100_000 + (s.charCodeAt(0) || 0)
}

function stepOutputs(step) {
  if (!step) return []
  return taskOutputsOf({
    outputs: step.outputs,
    evidence_paths: step.evidence_paths,
  })
}

function lookupSubtaskId(status, ...refs) {
  const map = status?.step_ref_to_subtask_id || {}
  for (const ref of refs) {
    const id = String(map[String(ref || '').trim()] || '').trim()
    if (id) return id
  }
  return ''
}

function lookupSubtaskStatus(subtaskStatus, ...refs) {
  for (const ref of refs) {
    const st = subtaskStatus?.[String(ref || '').trim()]
    if (st != null && String(st).trim()) return st
  }
  return ''
}

/**
 * @param {Array} planSteps
 * @param {Array} runtimeSteps
 * @returns {{ merged: Array, aliasToCanonical: Map<string,string>, canonicalRefs: string[] }}
 */
export function buildWorkflowStepBridge(planSteps, runtimeSteps) {
  const plan = Array.isArray(planSteps) ? planSteps : []
  const runtime = Array.isArray(runtimeSteps) ? runtimeSteps : []
  const aliasToCanonical = new Map()
  const merged = []
  const canonicalRefs = []

  const addAlias = (alias, canonical) => {
    const a = String(alias || '').trim()
    const c = String(canonical || '').trim()
    if (!a || !c) return
    aliasToCanonical.set(a, c)
  }

  if (runtime.length) {
    runtime.forEach((rt, i) => {
      const canonical = String(rt?.ref || '').trim() || String(i + 1)
      const planStep = plan[i] || null
      addAlias(canonical, canonical)

      if (planStep) {
        for (const alias of planStepAliasRefs(planStep, i)) addAlias(alias, canonical)
      }

      const semantic = runtimeStepSemanticRef(rt)
      if (semantic) addAlias(semantic, canonical)

      const planName = String(planStep?.name || planStep?.goal || '').trim()
      const rtName = stripRuntimeStepPrefix(rt?.name)
      const displayName = String(rt?.display_name || '').trim()
      const isRollup = !!(rt?.is_rollup_step || canonical === '__rollup__')

      merged.push({
        ref: canonical,
        plan_ref: planStep ? String(planStep.ref || i + 1).trim() : '',
        name: isRollup
          ? '结果汇总与验收'
          : displayName || planName || rtName || `步骤 ${canonical}`,
        assigned_agent: String(rt?.assigned_agent || planStep?.assigned_agent || '').trim(),
        is_rollup_step: isRollup,
        depends_on: Array.isArray(planStep?.depends_on) ? planStep.depends_on : [],
        plan_index: i,
      })
      canonicalRefs.push(canonical)
    })
  } else {
    plan.forEach((step, i) => {
      const canonical = String(step?.ref || i + 1).trim()
      for (const alias of planStepAliasRefs(step, i)) addAlias(alias, canonical)
      merged.push({
        ref: canonical,
        plan_ref: canonical,
        name: String(step?.name || step?.goal || `步骤 ${canonical}`).trim(),
        assigned_agent: String(step?.assigned_agent || '').trim(),
        is_rollup_step: false,
        depends_on: Array.isArray(step?.depends_on) ? step.depends_on : [],
        plan_index: i,
      })
      canonicalRefs.push(canonical)
    })
  }

  if (!merged.some((s) => s.is_rollup_step)) {
    const rollupRt = runtime.find(
      (s) => s?.is_rollup_step || String(s?.ref || '').trim() === '__rollup__',
    )
    if (rollupRt) {
      const canonical = '__rollup__'
      addAlias(canonical, canonical)
      merged.push({
        ref: canonical,
        plan_ref: '',
        name: '结果汇总与验收',
        assigned_agent: '',
        is_rollup_step: true,
        depends_on: [],
        plan_index: -1,
      })
      canonicalRefs.push(canonical)
    }
  }

  return { merged, aliasToCanonical, canonicalRefs }
}

export function resolveWorkflowStepRef(ref, bridge) {
  const r = String(ref || '').trim()
  if (!r) return ''
  if (!bridge?.aliasToCanonical) return r
  return bridge.aliasToCanonical.get(r) || r
}

export function listInspectableWorkflowSteps(planSteps, runtimeSteps) {
  return buildWorkflowStepBridge(planSteps, runtimeSteps).merged
}

export function findWorkflowPlanStep(planSteps, ref, bridge) {
  const plan = Array.isArray(planSteps) ? planSteps : []
  const canonical = resolveWorkflowStepRef(ref, bridge)
  const hit = bridge?.merged?.find((s) => s.ref === canonical)
  if (hit && hit.plan_index >= 0) return plan[hit.plan_index] || null
  return (
    plan.find((s, i) => {
      const aliases = planStepAliasRefs(s, i)
      return aliases.has(ref) || aliases.has(canonical)
    }) || null
  )
}

export function findWorkflowStepDetail(status, ref, planSteps) {
  const runtime = Array.isArray(status?.steps) ? status.steps : []
  const bridge = buildWorkflowStepBridge(planSteps, runtime)
  const canonical = resolveWorkflowStepRef(ref, bridge)
  const subtaskStatus = status?.subtask_status || {}

  let hit =
    runtime.find((s) => String(s?.ref || '').trim() === canonical) ||
    runtime.find((s) => {
      const r = String(s?.ref || '').trim()
      const sem = runtimeStepSemanticRef(s)
      return r === ref || sem === ref || r === canonical
    })

  if (hit) {
    const fromMap = lookupSubtaskId(status, canonical, ref)
    const subtaskId = fromMap || String(hit.subtask_id || '').trim()
    if (subtaskId && String(hit.subtask_id || '').trim() !== subtaskId) {
      return { ...hit, subtask_id: subtaskId }
    }
    return hit
  }

  const planStep = findWorkflowPlanStep(planSteps, ref, bridge)
  const statusVal =
    lookupSubtaskStatus(subtaskStatus, canonical, ref) || 'pending'

  return {
    ref: canonical,
    status: statusVal,
    name: planStep?.name || '',
    description: planStep?.goal || planStep?.description || '',
    assigned_agent: planStep?.assigned_agent || '',
    result_summary: '',
    error_text: '',
    progress: 0,
    started_at: null,
    completed_at: null,
    subtask_id: lookupSubtaskId(status, canonical, ref),
    subtask_thread_id: '',
    outputs: [],
    evidence_paths: [],
  }
}

export function resolveWorkflowSubtaskStatus(subtaskStatus, ref, bridge) {
  const canonical = resolveWorkflowStepRef(ref, bridge)
  return lookupSubtaskStatus(subtaskStatus, canonical, ref) || 'pending'
}

/**
 * Run-level deliverables for overview: run outputs → rollup → answer node → last successful step.
 */
export function collectWorkflowRunDeliverables(status, planSteps, options = {}) {
  const runtime = Array.isArray(status?.steps) ? status.steps : []
  let runItems = taskOutputsOf({
    outputs: status?.outputs,
    evidence_paths: status?.evidence_paths,
  })

  const hasHtml = runItems.some((it) => /\.html?$/i.test(String(it.value || '')))
  if (!hasHtml) {
    const rollup = runtime.find(
      (s) => s?.is_rollup_step || String(s?.ref || '').trim() === '__rollup__',
    )
    if (rollup) {
      const fromRollup = stepOutputs(rollup)
      if (fromRollup.length) runItems = fromRollup
    }
  }
  if (runItems.length) return runItems

  const bridge = buildWorkflowStepBridge(planSteps, runtime)
  const answerRef = String(
    options.answerFromRef || status?.answer_from_ref || '',
  ).trim()
  if (answerRef) {
    const canonical = resolveWorkflowStepRef(answerRef, bridge)
    const ansStep = runtime.find((s) => String(s?.ref || '').trim() === canonical)
    const fromAnswer = stepOutputs(ansStep)
    if (fromAnswer.length) return fromAnswer
  }

  const sorted = [...runtime].sort(
    (a, b) => refSortKey(a?.ref) - refSortKey(b?.ref),
  )
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const st = String(sorted[i]?.status || '').toLowerCase()
    if (!DONE_STATUS.has(st)) continue
    const outs = stepOutputs(sorted[i])
    if (outs.length) return outs
  }

  return runItems
}
