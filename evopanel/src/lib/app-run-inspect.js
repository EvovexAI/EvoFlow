/**
 * Shared App run inspect UI — same layout for history modal and debug dock.
 *
 * Left: nodes. Right: overview/detail | execution trajectory.
 * Click a node to switch both panes.
 */
import { api } from './tauri-api.js'
import { mountAppStepTranscript } from '../components/app-step-transcript.js'
import { resolveAssignedAgentDisplayName } from './tool-display.js'
import {
  renderOutputItemCardsHtml,
  taskOutputsOf,
} from './task-summary.js'
import { bindTaskOutputCardActions } from './task-output-preview.js'
import {
  buildWorkflowStepBridge,
  collectWorkflowRunDeliverables,
  findWorkflowPlanStep,
  findWorkflowStepDetail,
  listInspectableWorkflowSteps,
  resolveWorkflowStepRef,
  resolveWorkflowSubtaskStatus,
} from './app-workflow-step-bridge.js'

export const OVERVIEW_REF = '__overview__'

export const RUN_STATUS = {
  running: { label: '执行中', cls: 'executing' },
  executing: { label: '执行中', cls: 'executing' },
  completed: { label: '已完成', cls: 'completed' },
  failed: { label: '失败', cls: 'failed' },
  cancelled: { label: '已取消', cls: 'cancelled' },
  paused: { label: '已暂停', cls: 'paused' },
  plan_ready: { label: '待确认', cls: 'pending' },
  planned: { label: '待执行', cls: 'pending' },
}

export const STEP_STATUS = {
  pending: { label: '等待中', cls: 'pending' },
  planned: { label: '等待中', cls: 'pending' },
  executing: { label: '执行中', cls: 'running' },
  running: { label: '执行中', cls: 'running' },
  active: { label: '执行中', cls: 'running' },
  in_progress: { label: '执行中', cls: 'running' },
  completed: { label: '已完成', cls: 'done' },
  done: { label: '已完成', cls: 'done' },
  success: { label: '已完成', cls: 'done' },
  failed: { label: '失败', cls: 'failed' },
  error: { label: '失败', cls: 'failed' },
  cancelled: { label: '已取消', cls: 'skipped' },
  skipped: { label: '已跳过', cls: 'skipped' },
  paused: { label: '已暂停', cls: 'paused' },
}

export function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function formatDurationMs(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return s ? `${m}m ${s}s` : `${m}m`
}

export function stepDurationLabel(detail) {
  const start = detail?.started_at ? Date.parse(String(detail.started_at)) : NaN
  const end = detail?.completed_at ? Date.parse(String(detail.completed_at)) : NaN
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    return formatDurationMs(end - start)
  }
  return ''
}

function stepStatusUiCls(cls) {
  if (cls === 'done') return 'completed'
  if (cls === 'running') return 'executing'
  if (cls === 'failed') return 'failed'
  return 'pending'
}

function railStatusCls(statusCls) {
  if (statusCls === 'executing') return 'is-running'
  if (statusCls === 'completed') return 'is-done'
  if (statusCls === 'failed') return 'is-failed'
  if (statusCls === 'paused') return 'is-paused'
  return 'is-pending'
}

/** Shared shell: left nodes · split overview | trajectory. */
export function appRunInspectShellHtml() {
  return `
    <section class="app-run-inspect">
      <aside class="app-run-inspect-rail" aria-label="运行节点">
        <div class="app-run-inspect-rail-title">节点</div>
        <div class="app-run-inspect-rail-list" data-role="inspect-rail"></div>
      </aside>
      <div class="app-run-inspect-split">
        <div class="apps-history-inspect-body" data-role="inspect-body">
          <header class="apps-history-step-head" data-role="step-head"></header>
          <div class="apps-history-run-outputs" data-role="run-outputs"></div>
          <div class="apps-history-step-rows" data-role="step-rows"></div>
          <div class="apps-history-step-outputs" data-role="step-outputs"></div>
        </div>
        <div class="apps-history-log-block" data-role="log-block">
          <div class="apps-history-log-label" data-role="log-label">执行轨迹</div>
          <div class="apps-history-step-log" data-role="step-log">
            <div data-role="log-portal" class="wf-debug-chat-portal"></div>
          </div>
        </div>
      </div>
      <div data-role="transcript-host" class="apps-history-transcript-host"></div>
    </section>`
}

export function createAppRunInspectController(opts) {
  const root = opts.root
  if (!root) throw new Error('createAppRunInspectController: root required')

  let runId = ''
  let runStatus = null
  let inspectRef = null
  let generation = '0'
  /** @type {ReturnType<typeof mountAppStepTranscript> | null} */
  let transcript = null

  const host = root.querySelector('[data-role="transcript-host"]') || root
  transcript = mountAppStepTranscript(host)

  function agents() {
    return typeof opts.getAgentsCache === 'function' ? opts.getAgentsCache() || [] : []
  }

  function appData() {
    return typeof opts.getAppData === 'function' ? opts.getAppData() : null
  }

  function agentDisplayName(code) {
    return resolveAssignedAgentDisplayName(code, agents()) || String(code || '').trim()
  }

  function stepLabel(step, ref) {
    const name = String(step?.name || step?.goal || '').trim()
    if (name) return name
    const code = String(step?.assigned_agent || '').trim()
    if (code) return agentDisplayName(code)
    return `步骤 ${ref}`
  }

  function planSteps() {
    return appData()?.plan?.steps || []
  }

  function stepBridge(status) {
    return buildWorkflowStepBridge(planSteps(), status?.steps || [])
  }

  function findStepDetail(status, ref) {
    return findWorkflowStepDetail(status, ref, planSteps())
  }

  function listInspectableSteps(status) {
    return listInspectableWorkflowSteps(planSteps(), status?.steps || [])
  }

  function normalizeStepOutputs(detail) {
    return taskOutputsOf({
      outputs: detail?.outputs,
      evidence_paths: detail?.evidence_paths,
    })
  }

  function collectRunDeliverables(status) {
    return collectWorkflowRunDeliverables(status, planSteps(), {
      answerFromRef: appData()?.plan?.answer_from_ref || appData()?.answer_from_ref || '',
    })
  }

  function pickAutoStepRef(status) {
    const bridge = stepBridge(status)
    const steps = listInspectableSteps(status)
    const refs = steps.map((s) => s.ref)
    const subtaskStatus = status?.subtask_status || {}
    const overall = String(status?.status || '').toLowerCase()
    const isActive = (r) =>
      ['executing', 'running', 'active', 'in_progress'].includes(
        String(resolveWorkflowSubtaskStatus(subtaskStatus, r, bridge) || ''),
      )
    const running = refs.find((r) => isActive(r))
    if (running) return running
    const failed = refs.find((r) =>
      ['failed', 'error'].includes(String(resolveWorkflowSubtaskStatus(subtaskStatus, r, bridge) || '')),
    )
    if (failed) return failed
    if (['completed', 'failed', 'cancelled', 'canceled'].includes(overall)) {
      return OVERVIEW_REF
    }
    const done = [...refs].reverse().find((r) =>
      ['completed', 'done', 'success'].includes(
        String(resolveWorkflowSubtaskStatus(subtaskStatus, r, bridge) || ''),
      ),
    )
    return done || refs[0] || OVERVIEW_REF
  }

  function bindPreview(el, detail) {
    if (!el) return
    bindTaskOutputCardActions(el, {
      agentCode: String(detail?.assigned_agent || '').trim(),
    })
  }

  async function syncTranscript() {
    const gen = generation
    const logEl = root.querySelector('[data-role="step-log"]')
    const logBlock = root.querySelector('[data-role="log-block"]')
    const logLabel = root.querySelector('[data-role="log-label"]')
    if (!logEl || !runId || !runStatus) return

    const ref = inspectRef
    if (!ref || ref === OVERVIEW_REF) {
      if (logBlock) logBlock.hidden = true
      try {
        transcript?.close?.()
      } catch {
        /* ignore */
      }
      return
    }
    if (logBlock) logBlock.hidden = false
    const bridge = stepBridge(runStatus)
    const canonicalRef = resolveWorkflowStepRef(ref, bridge)
    const fromApi = findStepDetail(runStatus, ref)
    const planStep = findWorkflowPlanStep(planSteps(), ref, bridge)
    const title =
      String(fromApi?.name || planStep?.goal || planStep?.description || planStep?.name || '').trim() ||
      `步骤 ${ref}`
    if (logLabel) logLabel.textContent = `执行轨迹 · ${title}`

    const subtaskId = String(
      runStatus?.step_ref_to_subtask_id?.[canonicalRef] ||
        runStatus?.step_ref_to_subtask_id?.[ref] ||
        fromApi?.subtask_id ||
        '',
    ).trim()
    let leadThreadId = String(runStatus?.thread_id || '').trim()
    const mainTaskId = String(runStatus?.task_id || '').trim()
    if (!leadThreadId && mainTaskId) {
      try {
        const task = await api.getTask(mainTaskId)
        leadThreadId = String(task?.thread_id || '').trim()
      } catch {
        /* ignore */
      }
    }
    if (leadThreadId.startsWith('SubThread_') || leadThreadId.includes('__sub__')) leadThreadId = ''

    if (gen !== generation) return

    if (!mainTaskId || !subtaskId) {
      logEl.innerHTML = `
        <div class="wf-debug-empty-pane">
          <p>执行轨迹尚未就绪</p>
          <p class="wf-debug-empty-hint">该节点未关联到子任务会话</p>
        </div>`
      try {
        transcript?.close?.()
      } catch {
        /* ignore */
      }
      return
    }

    if (!logEl.querySelector('[data-role="log-portal"]')) {
      logEl.innerHTML = `<div data-role="log-portal" class="wf-debug-chat-portal"></div>`
    }
    const portal = logEl.querySelector('[data-role="log-portal"]')
    try {
      transcript?.open({
        mainTaskId,
        subtaskId,
        leadThreadId,
        title,
        status: String(
          fromApi?.status || resolveWorkflowSubtaskStatus(runStatus?.subtask_status, ref, bridge) || 'pending',
        ),
        assignedAgent: String(fromApi?.assigned_agent || planStep?.assigned_agent || ''),
        description: String(fromApi?.description || planStep?.goal || planStep?.description || ''),
        subtaskThreadId: String(fromApi?.subtask_thread_id || ''),
        mode: 'drawer',
        portalTarget: portal,
        readOnly: true,
        refreshKey: `${runId}:${ref}:${fromApi?.status || ''}`,
      })
    } catch (e) {
      logEl.innerHTML = `
        <div class="wf-debug-empty-pane">
          <p>无法加载执行轨迹</p>
          <p class="wf-debug-empty-hint">${escHtml((e && e.message) || String(e))}</p>
        </div>`
    }
  }

  function buildRows(status) {
    const overall = String(status.status || '').toLowerCase()
    const meta = RUN_STATUS[overall] || { label: overall || '未知', cls: 'pending' }
    const bridge = stepBridge(status)
    const inspectable = listInspectableSteps(status)
    const subtaskStatus = status.subtask_status || {}
    return [
      {
        ref: OVERVIEW_REF,
        label: '总览 · 综合详情',
        statusLabel: meta.label,
        statusCls: meta.cls,
        agent: '—',
        duration: '',
        kind: 'overview',
      },
      ...inspectable.map((step) => {
        const r = step.ref
        const detail = findStepDetail(status, r)
        const st = detail.status || resolveWorkflowSubtaskStatus(subtaskStatus, r, bridge) || 'pending'
        const sm = STEP_STATUS[st] || STEP_STATUS.pending
        const agentCode = String(detail.assigned_agent || step.assigned_agent || '').trim()
        return {
          ref: r,
          label: step.is_rollup_step ? '📦 结果汇总' : stepLabel(step, r),
          statusLabel: sm.label,
          statusCls: stepStatusUiCls(sm.cls),
          agent: agentCode ? agentDisplayName(agentCode) : '—',
          duration: stepDurationLabel(detail),
          kind: step.is_rollup_step ? 'rollup' : 'step',
        }
      }),
    ]
  }

  function activateRef(ref) {
    inspectRef = String(ref || '').trim() || OVERVIEW_REF
    opts.onInspectChange?.(inspectRef)
    render()
    void syncTranscript()
  }

  function bindRefActivators(scope) {
    scope.querySelectorAll('[data-ref]').forEach((el) => {
      const activate = () => activateRef(el.getAttribute('data-ref') || OVERVIEW_REF)
      el.addEventListener('click', activate)
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          activate()
        }
      })
    })
  }

  function render() {
    const railEl = root.querySelector('[data-role="inspect-rail"]')
    const headEl = root.querySelector('[data-role="step-head"]')
    const rowsEl = root.querySelector('[data-role="step-rows"]')
    const stepOutEl = root.querySelector('[data-role="step-outputs"]')
    const runOutEl = root.querySelector('[data-role="run-outputs"]')
    const logBlock = root.querySelector('[data-role="log-block"]')
    const logLabel = root.querySelector('[data-role="log-label"]')
    const bodyEl = root.querySelector('[data-role="inspect-body"]')
    if (!railEl || !headEl || !rowsEl || !runStatus) return

    if (!inspectRef) inspectRef = pickAutoStepRef(runStatus)
    const overall = String(runStatus.status || '').toLowerCase()
    const meta = RUN_STATUS[overall] || { label: overall || '未知', cls: 'pending' }
    const bridge = stepBridge(runStatus)
    const inspectable = listInspectableSteps(runStatus)
    const subtaskStatus = runStatus.subtask_status || {}
    const isOverview = inspectRef === OVERVIEW_REF
    const tableRows = buildRows(runStatus)

    railEl.innerHTML = tableRows
      .map((row) => {
        const active = row.ref === inspectRef ? ' is-active' : ''
        const kindCls =
          row.kind === 'overview' ? ' is-overview' : row.kind === 'rollup' ? ' is-rollup' : ''
        const st = railStatusCls(row.statusCls)
        const metaLine = [
          row.statusLabel,
          row.agent !== '—' ? row.agent : null,
          row.duration || null,
        ]
          .filter(Boolean)
          .join(' · ')
        return `
          <button type="button"
            class="app-run-inspect-rail-item ${st}${active}${kindCls}"
            data-ref="${escHtml(row.ref)}"
          >
            <span class="app-run-inspect-rail-dot" aria-hidden="true"></span>
            <span class="app-run-inspect-rail-copy">
              <strong title="${escHtml(row.label)}">${escHtml(row.label)}</strong>
              <small>${escHtml(metaLine)}</small>
            </span>
          </button>`
      })
      .join('')
    bindRefActivators(railEl)

    const splitEl = root.querySelector('.app-run-inspect-split')
    if (bodyEl) bodyEl.hidden = false
    if (logBlock) logBlock.hidden = isOverview
    if (splitEl) splitEl.classList.toggle('is-overview', isOverview)

    const runItems = collectRunDeliverables(runStatus)

    if (isOverview) {
      headEl.innerHTML = `
        <div>
          <strong>总览 · 综合详情</strong>
          <span class="apps-history-status ${meta.cls}">${escHtml(meta.label)}</span>
        </div>`

      const summary = String(runStatus.result_summary || '').trim()
      const nodeBits = inspectable.map((step) => {
        const detail = findStepDetail(runStatus, step.ref)
        const st =
          detail.status || resolveWorkflowSubtaskStatus(subtaskStatus, step.ref, bridge) || 'pending'
        const sm = STEP_STATUS[st] || STEP_STATUS.pending
        const name = step.is_rollup_step ? '结果汇总' : stepLabel(step, step.ref)
        const outs = normalizeStepOutputs(detail)
        return `${name}：${sm.label}${outs.length ? ` · ${outs.length} 项产出` : ''}`
      })

      const cells = [
        ['运行 ID', runId],
        ['进度', `${Math.min(100, Math.max(0, Number(runStatus.progress) || 0))}%`],
        nodeBits.length ? ['节点', nodeBits.join('\n')] : null,
        summary ? ['运行摘要', summary] : null,
      ].filter(Boolean)

      rowsEl.innerHTML = cells
        .map(([label, value]) => {
          const wide = label === '运行摘要' || label === '节点'
          return `
            <div class="wf-debug-row wf-debug-row--${wide ? 'block' : 'half'}" style="${wide ? 'grid-column:1/-1' : ''}">
              <div class="wf-debug-row-label">${escHtml(label)}</div>
              <div class="wf-debug-row-value">${
                wide
                  ? `<pre>${escHtml(value)}</pre>`
                  : `<span title="${escHtml(value)}">${escHtml(value)}</span>`
              }</div>
            </div>`
        })
        .join('')

      if (runOutEl) {
        if (runItems.length) {
          runOutEl.innerHTML = `
            <div class="apps-history-outputs-block">
              <div class="apps-history-outputs-title">综合产物（最终交付）</div>
              ${renderOutputItemCardsHtml(runItems, escHtml, { enablePreview: true })}
            </div>`
          bindPreview(runOutEl, { assigned_agent: '' })
        } else {
          runOutEl.innerHTML = `<div class="apps-history-outputs-empty">暂无运行级交付物</div>`
        }
      }
      if (stepOutEl) stepOutEl.innerHTML = ''
      if (logLabel) logLabel.textContent = '执行轨迹'
      void syncTranscript()
      return
    }

    if (runOutEl) runOutEl.innerHTML = ''

    const detail = findStepDetail(runStatus, inspectRef)
    const planStep = findWorkflowPlanStep(planSteps(), inspectRef, bridge)
    const sm = STEP_STATUS[detail.status] || STEP_STATUS.pending
    const metaStep = inspectable.find((s) => s.ref === inspectRef)
    const title = metaStep?.is_rollup_step
      ? '结果汇总与验收'
      : stepLabel(planStep || detail || metaStep, inspectRef)
    const agentCode = String(detail.assigned_agent || planStep?.assigned_agent || '').trim()
    const agent = agentCode ? agentDisplayName(agentCode) : ''
    const dur = stepDurationLabel(detail)
    const err = String(detail.error_text || '').trim()
    const result = String(detail.result_summary || '').trim()
    const goal = String(detail.description || planStep?.goal || planStep?.description || '').trim()
    const upstreamRefs = Array.isArray(planStep?.depends_on)
      ? planStep.depends_on.map((x) => String(x || '').trim()).filter(Boolean)
      : []
    const upstreamLabels = upstreamRefs.map((ur) => {
      const canonical = resolveWorkflowStepRef(ur, bridge)
      const up = inspectable.find((s) => s.ref === canonical)
      return up ? stepLabel(up, canonical) : ur
    })
    const stepItems = normalizeStepOutputs(detail)

    headEl.innerHTML = `
      <div class="wf-debug-pane-title wf-debug-pane-title--inline">
        <strong title="${escHtml(title)}">${escHtml(title)}</strong>
        <span class="apps-history-status ${stepStatusUiCls(sm.cls)}">${escHtml(sm.label)}</span>
        <span class="wf-debug-pane-meta">${escHtml(
          [agent || null, dur ? `耗时 ${dur}` : null].filter(Boolean).join(' · ') || '—',
        )}</span>
      </div>`

    rowsEl.innerHTML = `
      <div class="wf-debug-detail-block" style="grid-column:1/-1">
        <div class="wf-debug-detail-k">节点目标</div>
        <p class="wf-debug-detail-v">${escHtml(goal || '（无步骤说明）')}</p>
      </div>
      <div class="wf-debug-detail-block" style="grid-column:1/-1">
        <div class="wf-debug-detail-k">输入</div>
        <div class="wf-debug-io-card">
          <div class="wf-debug-io-row"><span>上游</span><span>${escHtml(
            upstreamLabels.length ? upstreamLabels.join('、') : '无上游（起始节点）',
          )}</span></div>
        </div>
      </div>
      <div class="wf-debug-detail-block" style="grid-column:1/-1">
        <div class="wf-debug-detail-k">输出摘要</div>
        ${
          result
            ? `<pre class="wf-debug-detail-pre">${escHtml(result)}</pre>`
            : `<p class="wf-debug-detail-muted">${
                sm.cls === 'running' ? '节点执行中，输出尚未落库…' : '暂无输出摘要'
              }</p>`
        }
      </div>
      ${
        err
          ? `<div class="wf-debug-detail-block is-error" style="grid-column:1/-1">
              <div class="wf-debug-detail-k">错误</div>
              <pre class="wf-debug-detail-pre">${escHtml(err)}</pre>
            </div>`
          : ''
      }`

    if (stepOutEl) {
      if (stepItems.length) {
        stepOutEl.innerHTML = `
          <div class="apps-history-outputs-block">
            <div class="apps-history-outputs-title">产出</div>
            ${renderOutputItemCardsHtml(stepItems, escHtml, { enablePreview: true })}
          </div>`
        bindPreview(stepOutEl, detail)
      } else {
        stepOutEl.innerHTML = `<div class="apps-history-outputs-empty">${
          sm.cls === 'running' ? '产出尚未生成…' : '本节点暂无结构化产出'
        }</div>`
      }
    }

    if (logLabel) logLabel.textContent = `执行轨迹 · ${title}`
    void syncTranscript()
  }
  return {
    getInspectRef: () => inspectRef,
    setInspectRef(ref) {
      inspectRef = String(ref || '').trim() || null
      render()
    },
    setRun({ runId: rid, runStatus: status, inspectRef: nextRef } = {}) {
      runId = String(rid || '').trim()
      runStatus = status || null
      generation = String(Date.now())
      if (nextRef !== undefined) {
        inspectRef = nextRef ? String(nextRef) : null
      } else {
        inspectRef = status ? pickAutoStepRef(status) : null
      }
      render()
    },
    updateStatus(status) {
      // Keep current inspectRef; callers that want auto-follow should use setRun().
      runStatus = status || null
      render()
    },
    render,
    syncTranscript,
    pickAutoStepRef,
    destroy() {
      generation = String(Date.now())
      try {
        transcript?.destroy?.()
      } catch {
        /* ignore */
      }
      transcript = null
      runStatus = null
      inspectRef = null
    },
  }
}
