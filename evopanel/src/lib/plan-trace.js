/**
 * Plan 链路单条日志。控制台过滤：`[plan]`
 *
 * 开启：localStorage.setItem('EVOFLOW_PLAN_TRACE', '1')
 * 详细工具行（final 或 plan>0 但 dock=hide 时自动展开）：`EVOFLOW_PLAN_TRACE_VERBOSE=1`
 */

import { analyzePlanTools, evaluatePlanExecDock } from './plan-pipeline.js'

const PREFIX = '[plan]'

export function isPlanTraceOn() {
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem('EVOFLOW_PLAN_TRACE') === '1'
  } catch {
    return false
  }
}

function isVerbose() {
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem('EVOFLOW_PLAN_TRACE_VERBOSE') === '1'
  } catch {
    return false
  }
}

let lastSig = ''

/**
 * @param {string} stage
 * @param {{
 *   toolCount?: number
 *   planCount?: number
 *   hitKind?: string
 *   hitTaskId?: string
 *   dock?: 'show' | 'hide'
 *   dockReason?: string
 *   phase?: string
 *   latched?: boolean
 *   summaries?: unknown[]
 * }} snap
 */
export function tracePlan(stage, snap) {
  if (!isPlanTraceOn()) return
  const line = [
    stage,
    `tools=${snap.toolCount ?? 0}`,
    `plan=${snap.planCount ?? 0}`,
    `hit=${snap.hitKind ?? 'none'}`,
    snap.latched ? 'latched=1' : '',
    snap.hitTaskId ? `task=${String(snap.hitTaskId).slice(-8)}` : '',
    `dock=${snap.dock ?? '?'}`,
    snap.dockReason ? `(${snap.dockReason})` : '',
    snap.phase ? `phase=${snap.phase}` : '',
  ]
    .filter(Boolean)
    .join(' | ')

  if (line === lastSig && stage !== 'final') return
  lastSig = line

   
  console.log(PREFIX, line)

  const verbose =
    isVerbose() ||
    stage === 'final' ||
    stage === 'patch' ||
    ((snap.dock === 'hide' || snap.hitKind === 'none') && (snap.planCount ?? 0) > 0)
  if (verbose && Array.isArray(snap.summaries) && snap.summaries.length) {
    const rows = snap.summaries.filter((s) => s?.isPlan || s?.hasInput || s?.hasOutput)
     
    console.log(PREFIX, 'tools', rows.length ? rows : snap.summaries)
    const planOnly = rows.filter((s) => s?.isPlan)
    if (planOnly.some((s) => s?.missReason)) {
       
      console.log(
        PREFIX,
        'miss',
        planOnly.map((s) => `${s.name}:${s.missReason || 'ok'}`).join(', '),
      )
    }
  }
}

/**
 * @param {string} stage
 * @param {unknown[]} tools
 * @param {Parameters<typeof evaluatePlanExecDock>[0]} dockInput
 */
export function tracePlanPipeline(stage, tools, dockInput) {
  const analyzed = analyzePlanTools(tools)
  const dockEval = evaluatePlanExecDock({
    ...dockInput,
    planHit: dockInput.planHit ?? analyzed.hit,
    streamingPlanComplete: analyzed.streamingPlanComplete,
    planRowCount: analyzed.planRows.length,
  })
  tracePlan(stage, {
    toolCount: analyzed.tools.length,
    planCount: analyzed.planRows.length,
    hitKind: analyzed.hitKind,
    hitTaskId: analyzed.hit?.taskId,
    latched: !!dockInput.streamPlanLatched,
    dock: dockEval.show ? 'show' : 'hide',
    dockReason: dockEval.reason,
    phase: dockInput.collabPhase,
    summaries: analyzed.summaries,
  })
  return { analyzed, dockEval }
}

export function resetPlanTrace() {
  lastSig = ''
}
