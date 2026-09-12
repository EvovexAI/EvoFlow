/**
 * 应用工作流编辑器 - 全屏画布（FastGPT 式：点击应用直接进入编排）
 * 「运行」= 同页填参 + 画布节点执行态 + 右侧运行结果（字段行 + 只读执行记录）。
 * `#/apps/:id/run` 留给外部入口。
 */
import { api, getGatewayBaseUrl } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showModal, showConfirm, showContentModal } from '../components/modal.js'
import { navigate, getCurrentRoute } from '../router.js'
import { mountAppWorkflowCanvas } from '../components/app-workflow-canvas.js'
import { mountAppStepTranscript } from '../components/app-step-transcript.js'
import {
  appRunInspectShellHtml,
  createAppRunInspectController,
  OVERVIEW_REF,
} from '../lib/app-run-inspect.js'
import { findWorkflowStepDetail } from '../lib/app-workflow-step-bridge.js'
import { promptAndRunApp, executionModeLabel } from '../lib/app-run-form.js'
import { mountParamsEditor } from '../lib/app-params-editor.js'
import { assessPublishReadiness, confirmPublishWarnings } from '../lib/app-publish-check.js'
import { appRunControlFlags } from '../lib/app-run-controls.js'
import { notifyDesktopCompletion } from '../lib/desktop-notification.js'
import { resolveAssignedAgentDisplayName } from '../lib/tool-display.js'
import { setAgentsDisplayCache } from '../lib/agents-display-cache.js'
import {
  buildCurlAsync,
  buildCurlSync,
  buildExampleChatRequest,
  buildExampleChatResponse,
  buildExampleVariables,
  buildPythonSdk,
  buildResponseContractSummary,
} from '../lib/app-api-call-example.js'

/** AppRun subtask 状态 → 画布节点执行态 */
function mapSubtaskToExec(st) {
  const s = String(st || '').toLowerCase()
  if (['executing', 'running', 'active', 'in_progress'].includes(s)) return 'running'
  if (['completed', 'done', 'success'].includes(s)) return 'done'
  if (['failed', 'error'].includes(s)) return 'failed'
  if (['cancelled', 'skipped', 'skip'].includes(s)) return 'skipped'
  if (s === 'paused') return 'paused'
  return 'pending'
}

function buildExecMapFromStatus(appData, subtaskStatus) {
  const steps = appData?.plan?.steps || []
  const map = {}
  steps.forEach((step, i) => {
    const ref = String(step.ref || i + 1)
    map[ref] = mapSubtaskToExec(subtaskStatus?.[ref])
  })
  return map
}

const STATUS_META = {
  pending: { label: '等待中', short: '等待', cls: 'pending' },
  planned: { label: '等待中', short: '等待', cls: 'pending' },
  plan_ready: { label: '待确认', short: '待确认', cls: 'pending' },
  executing: { label: '执行中', short: '执行中', cls: 'running' },
  running: { label: '执行中', short: '执行中', cls: 'running' },
  active: { label: '执行中', short: '执行中', cls: 'running' },
  in_progress: { label: '执行中', short: '执行中', cls: 'running' },
  completed: { label: '已完成', short: '完成', cls: 'done' },
  done: { label: '已完成', short: '完成', cls: 'done' },
  success: { label: '已完成', short: '完成', cls: 'done' },
  failed: { label: '失败', short: '失败', cls: 'failed' },
  error: { label: '失败', short: '失败', cls: 'failed' },
  cancelled: { label: '已取消', short: '取消', cls: 'skipped' },
  skipped: { label: '已跳过', short: '跳过', cls: 'skipped' },
  skip: { label: '已跳过', short: '跳过', cls: 'skipped' },
  paused: { label: '已暂停', short: '暂停', cls: 'paused' },
  unknown: { label: '未知', short: '未知', cls: 'pending' },
}

function formatDurationMs(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return s ? `${m}m ${s}s` : `${m}m`
}

function stepDurationLabel(detail) {
  const start = detail?.started_at ? Date.parse(String(detail.started_at)) : NaN
  const end = detail?.completed_at ? Date.parse(String(detail.completed_at)) : NaN
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    return formatDurationMs(end - start)
  }
  const exec = mapSubtaskToExec(detail?.status)
  if (Number.isFinite(start) && (exec === 'running' || exec === 'paused')) {
    return formatDurationMs(Date.now() - start)
  }
  return ''
}

function formatClock(iso) {
  if (!iso) return ''
  const d = new Date(String(iso))
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

let workflowCanvas = null
let canvasMountEl = null
let execPollTimer = null
let debugDockEl = null
let restoreChipEl = null
let stepTranscript = null
let runInspect = null
/** @type {any[]} */
let agentsCache = []
/** @type {{ runId: string, taskId: string|null, status: object|null, inspectRef: string|null, userPicked: boolean } | null} */
let debugSession = null

const DEBUG_DOCK_WIDTH_LS = 'evopanel_wf_debug_dock_width'
const DEBUG_DOCK_WIDTH_DEFAULT = 1240
const DEBUG_DOCK_WIDTH_MIN = 1000
const DEBUG_DOCK_WIDTH_MAX = 1480

function loadDebugDockWidth() {
  try {
    const n = Number(localStorage.getItem(DEBUG_DOCK_WIDTH_LS))
    if (Number.isFinite(n) && n >= 720 && n <= DEBUG_DOCK_WIDTH_MAX) {
      // migrate previous default (≤1080) to the new wider default
      if (n <= 1080) return DEBUG_DOCK_WIDTH_DEFAULT
      return Math.round(Math.max(DEBUG_DOCK_WIDTH_MIN, n))
    }
  } catch {
    /* ignore */
  }
  return DEBUG_DOCK_WIDTH_DEFAULT
}

function saveDebugDockWidth(px) {
  try {
    localStorage.setItem(DEBUG_DOCK_WIDTH_LS, String(Math.round(px)))
  } catch {
    /* ignore */
  }
}

function applyDebugDockWidth(px, studioCenter = null) {
  const center =
    studioCenter ||
    canvasMountEl?.querySelector('.app-wf-studio-center') ||
    canvasMountEl
  if (!center) return
  const hostW = center.getBoundingClientRect().width || window.innerWidth
  const maxByHost = Math.max(720, Math.floor(hostW - 32))
  const clamped = Math.min(
    DEBUG_DOCK_WIDTH_MAX,
    maxByHost,
    Math.max(Math.min(DEBUG_DOCK_WIDTH_MIN, maxByHost), Math.round(px)),
  )
  center.style.setProperty('--wf-debug-dock-width', `${clamped}px`)
  return clamped
}

function bindDebugDockResize(dock, studioCenter) {
  const handle = dock.querySelector('[data-role="dock-resize"]')
  if (!handle || handle.dataset.bound === '1') return
  handle.dataset.bound = '1'

  const onPointerDown = (e) => {
    if (window.matchMedia('(max-width: 720px)').matches) return
    e.preventDefault()
    const startX = e.clientX
    const startW =
      dock.getBoundingClientRect().width ||
      loadDebugDockWidth() ||
      DEBUG_DOCK_WIDTH_DEFAULT
    dock.classList.add('is-resizing')
    studioCenter.classList.add('is-resizing-debug-dock')
    try {
      handle.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }

    const onMove = (ev) => {
      // 向左拖 = 面板变宽
      const next = startW + (startX - ev.clientX)
      applyDebugDockWidth(next, studioCenter)
    }
    const onUp = (ev) => {
      dock.classList.remove('is-resizing')
      studioCenter.classList.remove('is-resizing-debug-dock')
      try {
        handle.releasePointerCapture(ev.pointerId)
      } catch {
        /* ignore */
      }
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      const finalW = dock.getBoundingClientRect().width
      if (finalW > 0) saveDebugDockWidth(applyDebugDockWidth(finalW, studioCenter))
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }
  handle.addEventListener('pointerdown', onPointerDown)
}

export function cleanup() {
  stopExecSession({ clearNodes: true })
  try {
    stepTranscript?.destroy?.()
  } catch {}
  stepTranscript = null
  try {
    runInspect?.destroy?.()
  } catch {}
  runInspect = null
  if (workflowCanvas && canvasMountEl) {
    workflowCanvas.destroy()
    workflowCanvas = null
    canvasMountEl = null
  }
}

function stopExecSession({ clearNodes = false } = {}) {
  if (execPollTimer) {
    clearInterval(execPollTimer)
    execPollTimer = null
  }
  try {
    stepTranscript?.close?.()
  } catch {}
  if (restoreChipEl) {
    restoreChipEl.remove()
    restoreChipEl = null
  }
  if (debugDockEl) {
    debugDockEl.remove()
    debugDockEl = null
  }
  canvasMountEl?.querySelector('.app-wf-studio-center')?.classList.remove('has-debug-dock')
  if (clearNodes) {
    workflowCanvas?.clearExecStatus?.()
    debugSession = null
    workflowCanvas?.setAppMeta?.({ runId: undefined, parameters: {} })
  }
}

export async function render() {
  const hash = getCurrentRoute()
  const pathParts = hash.split('?')[0].split('/')
  const appId = pathParts[2]
  const qs = hash.includes('?') ? new URLSearchParams(hash.split('?')[1]) : null
  const autoRun = qs?.get('action') === 'run'
  const resumeRunId = String(qs?.get('run') || '').trim()

  if (!appId) {
    const page = document.createElement('div')
    page.innerHTML =
      '<div style="padding:40px;text-align:center;color:var(--text-tertiary)">无效的工作流 ID，<a href="#/apps">返回工作流列表</a></div>'
    return page
  }

  cleanup()

  const page = document.createElement('div')
  page.className = 'page app-editor-page app-editor-page--bare'
  page.innerHTML = `
    <div class="app-wf-page-body" id="app-editor-canvas">
      <div class="page-loader app-editor-loader">
        <div class="page-loader-spinner"></div>
        <div class="page-loader-text">加载工作流…</div>
      </div>
    </div>
  `

  canvasMountEl = page.querySelector('#app-editor-canvas')
  stepTranscript = mountAppStepTranscript(page)
  let appData = null

  async function persistPlan(exported, { publish = false } = {}) {
    // 已发布应用「保存」不再降级为 draft（否则 OpenAPI/建 Key 立刻失效）。
    // 草稿仍写 draft；点「发布」走 publishApp 升闸门。
    const wasPublished = String(appData?.status || '').toLowerCase() === 'published'
    const payload = {
      plan: {
        goal: exported.goal,
        steps: exported.steps,
        canvas: exported.canvas || {},
        answer_from_ref: exported.answer_from_ref || '',
      },
      flowchart_mermaid: exported.flowchart_mermaid,
      answer_from_ref: exported.answer_from_ref || '',
    }
    if (!publish && !wasPublished) {
      payload.status = 'draft'
    }
    await api.updateApp(appId, payload)
    if (publish) await api.publishApp(appId)
  }

  async function loadApp() {
    try {
      appData = await api.getApp(appId)
      updateHeader()
      mountCanvas()
      void ensureAgentsCache()
      if (autoRun || resumeRunId) {
        // 去掉 query，避免刷新重复触发
        if (window.location.hash.includes('?')) {
          window.history.replaceState(null, '', `#/apps/${appId}`)
        }
        if (resumeRunId) {
          void openRunDebug(resumeRunId)
        } else if (autoRun) {
          void runFromEditor()
        }
      }
    } catch (e) {
      toast.error('加载工作流失败: ' + e.message)
      canvasMountEl.innerHTML = `<div class="app-editor-error">${escHtml(e.message)}</div>`
    }
  }

  function updateHeader() {
    workflowCanvas?.setAppMeta?.({
      appName: appData.name || '',
      appStatus: appData.status || 'draft',
      appIcon: appData.icon || '◇',
      appParameters: Array.isArray(appData.parameters) ? appData.parameters : [],
    })
  }

  function mountCanvas() {
    if (workflowCanvas) workflowCanvas.destroy()
    canvasMountEl.innerHTML = ''

    const plan = appData.plan || {}
    workflowCanvas = mountAppWorkflowCanvas(canvasMountEl, {
      variant: 'fullscreen',
      goal: plan.goal || appData.description || '',
      steps: plan.steps || [],
      canvas: plan.canvas || appData.canvas || null,
      appName: appData.name || '',
      appStatus: appData.status || 'draft',
      appIcon: appData.icon || '◇',
      appParameters: Array.isArray(appData.parameters) ? appData.parameters : [],
      appId,
      runId: debugSession?.runId || undefined,
      parameters: {},
      onBack: () => {
        if (workflowCanvas?.isDirty?.()) {
          if (!window.confirm('有未保存的修改，确定离开？')) return
        }
        navigate('/apps')
      },
      onRun: () => void runFromEditor(),
      onInspectStep: (stepRef) => {
        if (debugSession?.runId) selectDebugStep(stepRef, { userPicked: true })
      },
      onRename: async (name) => {
        const trimmed = name.trim()
        if (!trimmed || trimmed === appData.name) return
        try {
          await saveAppMeta({ name: trimmed })
        } catch (err) {
          toast.error('更新名称失败: ' + err.message)
          updateHeader()
        }
      },
      onOpenAppSettings: () => showSettingsModal(),
      onOpenHistory: () => navigate(`/apps/${appId}/history`),
      onOpenVersions: () => showRevisionsModal(),
      onOpenApiAccess: () => showApiAccessModal(),
      onSave: async (exported) => {
        const wasPublished = String(appData?.status || '').toLowerCase() === 'published'
        await persistPlan(exported)
        toast.success(
          wasPublished
            ? '已保存 · 仍为已发布（旧 API Key 不受影响）'
            : '已保存为草稿',
        )
        appData = await api.getApp(appId)
        updateHeader()
      },
      onPublish: async (exported) => {
        const check = assessPublishReadiness(exported, appData?.parameters || [])
        if (check.blockers.length) {
          toast.warning(check.blockers.join('；'))
          return false
        }
        // 已发布过的再点发布：只拦致命问题，避免每次保存式重发都被提示轰炸
        const alreadyPublished = String(appData?.status || '').toLowerCase() === 'published'
        if (!alreadyPublished && check.warnings.length) {
          const go = await confirmPublishWarnings(check.warnings)
          if (!go) return false
        }
        await persistPlan(exported, { publish: true })
        appData = await api.getApp(appId)
        updateHeader()
        showPublishNextModal()
        return true
      },
    })
  }

  /** 发布成功：引导填参运行或创建 API，而不是直接砸工程师弹窗 */
  function showPublishNextModal() {
    const overlay = showContentModal({
      title: '发布成功',
      width: 440,
      content: `
        <p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:var(--text-secondary)">
          工作流已对外可用。下一步可以：
        </p>
        <ul style="margin:0;padding-left:1.2em;font-size:13px;line-height:1.7;color:var(--text-secondary)">
          <li><strong>填参运行</strong> — 在运行页按表单启动（最常用）</li>
          <li><strong>创建 API Key</strong> — 给外部系统 / 脚本调用</li>
          <li>或关闭后继续在画布微调（保存不会掉发布）</li>
        </ul>
      `,
      buttons: [
        { label: '填参运行', className: 'btn btn-primary btn-sm', id: 'btn-pub-run' },
        { label: '创建 API Key', className: 'btn btn-secondary btn-sm', id: 'btn-pub-api' },
      ],
    })
    const cancelBtn = overlay.querySelector('[data-action="cancel"]')
    if (cancelBtn) cancelBtn.textContent = '继续编排'
    overlay.querySelector('#btn-pub-run')?.addEventListener('click', () => {
      overlay.close()
      navigate(`/apps/${appId}/run`)
    })
    overlay.querySelector('#btn-pub-api')?.addEventListener('click', () => {
      overlay.close()
      showApiAccessModal()
    })
  }

  async function saveAppMeta(fields) {
    await api.updateApp(appId, fields)
    appData = await api.getApp(appId)
    updateHeader()
  }

  // ─── 同页调试：底部详情坞（步骤轨 + 耗时/输出 + 对话工具） ───

  async function runFromEditor() {
    if (!appData) return
    if (workflowCanvas?.isDirty?.()) {
      const ok = await showConfirm('有未保存的修改，运行前先保存草稿？')
      if (!ok) return
      try {
        await workflowCanvas.saveDraft()
        appData = await api.getApp(appId)
        updateHeader()
      } catch (e) {
        toast.error('保存失败: ' + (e?.message || e))
        return
      }
    }
    const plan = workflowCanvas?.getPlan?.()
    if (plan?.steps) {
      appData = {
        ...appData,
        plan: { ...(appData.plan || {}), goal: plan.goal, steps: plan.steps, canvas: plan.canvas },
      }
    }

    const result = await promptAndRunApp(appData, {
      onParamsSaved: (nextParams) => {
        appData = { ...appData, parameters: nextParams }
      },
      onStarted: (started, values) => {
        const runId = started?.run_id
        const taskId = started?.task_id
        if (!runId) {
          if (taskId) toast.info('已创建任务，可从运行历史查看运行结果')
          return
        }
        const pendingMap = {}
        ;(appData?.plan?.steps || []).forEach((step, i) => {
          pendingMap[String(step.ref || i + 1)] = 'pending'
        })
        workflowCanvas?.setExecStatus?.(pendingMap)
        debugSession = {
          runId,
          taskId: taskId || null,
          status: null,
          inspectRef: null,
          userPicked: false,
          lastParams: values && typeof values === 'object' ? { ...values } : {},
          activeTab: 'live',
        }
        startExecSession(runId)
      },
    })
    if (!result) return
  }

  function agentDisplayName(code) {
    const c = String(code || '').trim()
    if (!c) return ''
    return resolveAssignedAgentDisplayName(c, agentsCache) || c
  }

  /** 步骤主标题：优先步骤名/目标，不用智能体名 */
  function stepTitle(step, ref) {
    return (
      String(step?.name || step?.goal || step?.description || '').trim().slice(0, 56) ||
      `步骤 ${ref}`
    )
  }

  function stepAgentLabel(step) {
    const code = String(step?.assigned_agent || '').trim()
    return code ? agentDisplayName(code) : ''
  }

  function stepDepsOf(step) {
    return (Array.isArray(step?.depends_on) ? step.depends_on : [])
      .map((d) => String(d || '').trim())
      .filter(Boolean)
  }

  function statusGlyph(cls) {
    if (cls === 'done') return '✓'
    if (cls === 'running') return '●'
    if (cls === 'paused') return 'Ⅱ'
    if (cls === 'failed') return '!'
    if (cls === 'skipped') return '—'
    return '○'
  }

  /** 按 depends_on 计算深度与并行组，用于流程树缩进 */
  function computeFlowItems(planSteps) {
    const list = Array.isArray(planSteps) ? planSteps : []
    const byRef = new Map()
    list.forEach((step, i) => {
      const ref = String(step.ref || i + 1)
      byRef.set(ref, { step, ref, deps: stepDepsOf(step), index: i })
    })
    const depthMap = new Map()
    const getDepth = (ref, stack = new Set()) => {
      if (depthMap.has(ref)) return depthMap.get(ref)
      if (stack.has(ref)) return 0
      stack.add(ref)
      const node = byRef.get(ref)
      if (!node?.deps.length) {
        depthMap.set(ref, 0)
        return 0
      }
      const upstream = node.deps
        .filter((d) => byRef.has(d))
        .map((d) => getDepth(d, stack))
      const d = upstream.length ? 1 + Math.max(...upstream) : 0
      depthMap.set(ref, d)
      return d
    }
    for (const ref of byRef.keys()) getDepth(ref)

    const ordered = [...byRef.values()].sort((a, b) => {
      const dd = (depthMap.get(a.ref) || 0) - (depthMap.get(b.ref) || 0)
      if (dd !== 0) return dd
      return a.index - b.index
    })

    const groups = new Map()
    for (const item of ordered) {
      const key = `${depthMap.get(item.ref)}|${[...item.deps].sort().join(',')}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item.ref)
    }

    return ordered.map((item) => {
      const key = `${depthMap.get(item.ref)}|${[...item.deps].sort().join(',')}`
      const group = groups.get(key) || [item.ref]
      const branchIndex = group.indexOf(item.ref)
      return {
        ...item,
        depth: depthMap.get(item.ref) || 0,
        isParallel: group.length > 1,
        branchIndex,
        branchCount: group.length,
        isLastBranch: branchIndex === group.length - 1,
      }
    })
  }

  function currentPhaseText(planSteps, subtaskStatus, overall) {
    const items = (planSteps || []).map((step, i) => {
      const ref = String(step.ref || i + 1)
      const st = String(subtaskStatus?.[ref] || 'pending').toLowerCase()
      return { ref, step, st, title: stepTitle(step, ref) }
    })
    const running = items.filter((x) =>
      ['executing', 'running', 'active', 'in_progress'].includes(x.st),
    )
    if (String(overall || '').toLowerCase() === 'completed') return '全部节点已完成'
    if (String(overall || '').toLowerCase() === 'failed') {
      const failed = items.find((x) => ['failed', 'error'].includes(x.st))
      return failed ? `「${failed.title}」执行失败` : '运行失败'
    }
    if (String(overall || '').toLowerCase() === 'paused') return '任务已暂停'
    if (running.length >= 2) {
      return `并行处理 ${running.map((x) => x.title).slice(0, 3).join(' 和 ')}`
    }
    if (running.length === 1) return running[0].title
    const pending = items.find((x) =>
      !['completed', 'done', 'success', 'skipped', 'skip', 'cancelled', 'canceled', 'failed', 'error'].includes(x.st),
    )
    return pending ? `等待：${pending.title}` : '等待下一节点…'
  }

  async function ensureAgentsCache() {
    if (agentsCache.length) return
    try {
      const list = await api.listAgents()
      agentsCache = Array.isArray(list) ? list : []
      try {
        setAgentsDisplayCache(agentsCache)
      } catch {
        /* optional */
      }
    } catch {
      agentsCache = []
    }
  }

  function findStepDetail(status, ref) {
    return findWorkflowStepDetail(status, ref, appData?.plan?.steps || [])
  }

  function pickAutoStepRef(subtaskStatus) {
    const refs = (appData?.plan?.steps || []).map((s, i) => String(s.ref || i + 1))
    const running = refs.find((r) =>
      ['executing', 'running', 'active', 'in_progress'].includes(String(subtaskStatus?.[r] || '')),
    )
    if (running) return running
    const failed = refs.find((r) => ['failed', 'error'].includes(String(subtaskStatus?.[r] || '')))
    if (failed) return failed
    const pending = refs.find(
      (r) => !['completed', 'done', 'success', 'cancelled', 'skipped', 'skip'].includes(String(subtaskStatus?.[r] || '')),
    )
    return pending || refs[0] || null
  }

  function selectDebugStep(stepRef, { userPicked = false } = {}) {
    if (!debugSession) return
    const next = String(stepRef || '').trim()
    if (!next) return
    debugSession.inspectRef = next
    debugSession.userPicked = !!userPicked
    runInspect?.setInspectRef(next)
    void syncStepLog()
  }

  function showRestoreChip() {
    const studioCenter = canvasMountEl?.querySelector('.app-wf-studio-center') || canvasMountEl
    if (!studioCenter || restoreChipEl) return
    restoreChipEl = document.createElement('button')
    restoreChipEl.type = 'button'
    restoreChipEl.className = 'wf-run-chip wf-run-chip--restore'
    restoreChipEl.textContent = '查看运行结果'
    restoreChipEl.addEventListener('click', () => expandDebugDock())
    studioCenter.appendChild(restoreChipEl)
  }

  function hideRestoreChip() {
    if (restoreChipEl) {
      restoreChipEl.remove()
      restoreChipEl = null
    }
  }

  function collapseDebugDock() {
    if (!debugDockEl) return
    try {
      stepTranscript?.close?.()
    } catch {}
    debugDockEl.classList.add('is-collapsed')
    canvasMountEl?.querySelector('.app-wf-studio-center')?.classList.remove('has-debug-dock')
    showRestoreChip()
  }

  function expandDebugDock() {
    hideRestoreChip()
    if (!debugDockEl) ensureDebugDockMounted()
    debugDockEl?.classList.remove('is-collapsed')
    canvasMountEl?.querySelector('.app-wf-studio-center')?.classList.add('has-debug-dock')
    if (debugSession) {
      renderDebugDockBody()
      void syncStepLog()
    }
  }

  /** 从运行历史 / ?run= 恢复调试面板（留在应用页） */
  function openRunDebug(runId, taskId = null) {
    const rid = String(runId || '').trim()
    if (!rid) {
      toast.error('缺少运行 ID')
      return
    }
    const pendingMap = {}
    ;(appData?.plan?.steps || []).forEach((step, i) => {
      pendingMap[String(step.ref || i + 1)] = 'pending'
    })
    workflowCanvas?.setExecStatus?.(pendingMap)
    debugSession = {
      runId: rid,
      taskId: taskId ? String(taskId) : null,
      status: null,
      inspectRef: null,
      userPicked: false,
      lastParams: {},
      activeTab: 'live',
    }
    startExecSession(rid)
  }

  async function syncStepLog() {
    if (!debugSession?.runId || !runInspect) return
    try {
      const fresh = await api.getAppRunStatus(debugSession.runId)
      if (fresh) {
        debugSession.status = fresh
        if (fresh.task_id) debugSession.taskId = fresh.task_id
        workflowCanvas?.setExecStatus?.(
          buildExecMapFromStatus(appData, fresh.subtask_status || {}),
        )
        runInspect.updateStatus(fresh)
      }
    } catch {
      /* ignore */
    }
    await runInspect.syncTranscript()
  }

  function ensureDebugDockMounted() {
    const studioCenter = canvasMountEl?.querySelector('.app-wf-studio-center') || canvasMountEl
    if (!studioCenter) return null
    if (!debugDockEl) {
      debugDockEl = document.createElement('div')
      debugDockEl.className = 'wf-debug-dock wf-debug-dock--bench'
      debugDockEl.innerHTML = `
        <div
          class="wf-debug-dock-resize"
          data-role="dock-resize"
          title="拖拽调整宽度"
          aria-label="拖拽调整调试工作台宽度"
          role="separator"
          aria-orientation="vertical"
        ></div>
        <div class="wf-debug-dock-bar">
          <div class="wf-debug-hero">
            <div class="wf-debug-hero-top">
              <div class="wf-debug-hero-copy">
                <span class="wf-debug-dock-pulse" data-role="pulse" aria-hidden></span>
                <div class="wf-debug-hero-text">
                  <div class="wf-debug-hero-title-row">
                    <span class="wf-debug-hero-kicker" data-role="hero-title">调试运行</span>
                    <span class="wf-debug-dock-status" data-role="status-line">准备中</span>
                  </div>
                  <span class="wf-debug-hero-meta" data-role="hero-meta">等待启动…</span>
                </div>
              </div>
              <div class="wf-debug-dock-bar-right">
                <button type="button" class="wf-debug-dock-btn" data-role="btn-pause" hidden>暂停</button>
                <button type="button" class="wf-debug-dock-btn" data-role="btn-resume" hidden>继续</button>
                <button type="button" class="wf-debug-dock-btn wf-debug-dock-btn--danger" data-role="btn-cancel" hidden>终止</button>
                <button type="button" class="wf-debug-dock-btn wf-debug-dock-btn--ghost" data-role="btn-close" title="收起面板，任务继续后台运行">收起</button>
              </div>
            </div>
            <div class="wf-debug-dock-track" aria-hidden><i data-role="bar"></i></div>
          </div>
        </div>
        <div class="wf-debug-dock-main wf-debug-dock-main--inspect" data-role="inspect-root"></div>
        <footer class="wf-debug-dock-footer" data-role="dock-footer" hidden></footer>`
      studioCenter.appendChild(debugDockEl)
      studioCenter.classList.add('has-debug-dock')
      applyDebugDockWidth(loadDebugDockWidth(), studioCenter)
      bindDebugDockResize(debugDockEl, studioCenter)
      const inspectRoot = debugDockEl.querySelector('[data-role="inspect-root"]')
      if (inspectRoot) {
        inspectRoot.innerHTML = appRunInspectShellHtml()
        try { runInspect?.destroy?.() } catch {}
        runInspect = createAppRunInspectController({
          root: inspectRoot,
          getAppData: () => appData,
          getAgentsCache: () => agentsCache,
          onInspectChange: (ref) => {
            if (!debugSession) return
            debugSession.inspectRef = ref
            debugSession.userPicked = true
          },
        })
      }
    } else {
      // Drop stale dock shells that predate shared inspect layout.
      if (!debugDockEl.querySelector('[data-role="inspect-root"]') && !debugDockEl.querySelector('[data-role="inspect-rail"]')) {
        try {
          debugDockEl.remove()
        } catch {
          /* ignore */
        }
        debugDockEl = null
        return ensureDebugDockMounted()
      }
      applyDebugDockWidth(loadDebugDockWidth(), studioCenter)
    }
    return debugDockEl
  }

  function bindDebugDockTabs() {
    if (!debugDockEl || debugDockEl._tabsBound) return
    debugDockEl._tabsBound = true
    debugDockEl.addEventListener('click', async (e) => {
      const tabBtn = e.target.closest?.('[data-tab]')
      if (tabBtn && debugDockEl.contains(tabBtn) && tabBtn.matches('.wf-debug-tab')) {
        const tab = tabBtn.getAttribute('data-tab') || 'live'
        if (debugSession) debugSession.activeTab = tab
        debugDockEl.querySelectorAll('.wf-debug-tab').forEach((b) => {
          b.classList.toggle('is-active', b.getAttribute('data-tab') === tab)
        })
        debugDockEl.querySelectorAll('[data-tab-panel]').forEach((p) => {
          const on = p.getAttribute('data-tab-panel') === tab
          p.hidden = !on
          p.classList.toggle('is-active', on)
        })
        if (tab === 'live') void syncStepLog()
        return
      }

      const copyBtn = e.target.closest?.('[data-act="copy-path"]')
      if (copyBtn) {
        e.preventDefault()
        const path = copyBtn.getAttribute('data-path') || ''
        if (!path) return
        try {
          await navigator.clipboard.writeText(path)
          toast.success('路径已复制')
        } catch {
          toast.error('复制失败')
        }
        return
      }

      const footerAct = e.target.closest?.('[data-footer-act]')?.getAttribute('data-footer-act')
      if (!footerAct) return
      if (footerAct === 'close') {
        collapseDebugDock()
        return
      }
      if (footerAct === 'artifacts') {
        if (debugSession) {
          debugSession.inspectRef = OVERVIEW_REF
          debugSession.userPicked = true
        }
        runInspect?.setInspectRef(OVERVIEW_REF)
        renderDebugDockBody()
        return
      }
      if (footerAct === 'task') {
        const tid = String(debugSession?.taskId || debugSession?.status?.task_id || '').trim()
        if (tid) window.location.hash = `#/task/${encodeURIComponent(tid)}`
        else toast.info('暂无关联任务')
        return
      }
      if (footerAct === 'rerun') {
        const values = debugSession?.lastParams || {}
        try {
          const started = await api.runApp(appId, {
            parameters: values,
            execution_mode: appData?.execution_mode || 'workflow',
            run_kind: 'debug',
            trigger_kind: 'manual',
          })
          const runId = started?.run_id
          if (!runId) {
            toast.error('再次运行失败：未返回 run_id')
            return
          }
          toast.success('已使用相同参数再次运行')
          const pendingMap = {}
          ;(appData?.plan?.steps || []).forEach((step, i) => {
            pendingMap[String(step.ref || i + 1)] = 'pending'
          })
          workflowCanvas?.setExecStatus?.(pendingMap)
          debugSession = {
            runId,
            taskId: started?.task_id || null,
            status: null,
            inspectRef: null,
            userPicked: false,
            lastParams: { ...values },
            activeTab: 'live',
          }
          startExecSession(runId)
        } catch (err) {
          toast.error('再次运行失败: ' + (err?.message || err))
        }
      }
    })
  }

  function renderDebugDockBody() {
    if (!debugDockEl || !debugSession) return
    bindDebugDockTabs()
    const status = debugSession.status || {}
    const titleEl = debugDockEl.querySelector('[data-role="hero-title"]')
    if (titleEl) {
      const appName = String(appData?.name || '').trim()
      titleEl.textContent = appName ? `调试运行 / ${appName}` : '调试运行'
    }
    const footerEl = debugDockEl.querySelector('[data-role="dock-footer"]')
    const overall = String(status.status || '').toLowerCase()
    const terminal = ['completed', 'failed', 'cancelled', 'canceled'].includes(overall)
    if (footerEl) {
      if (terminal) {
        footerEl.hidden = false
        if (overall === 'completed') {
          footerEl.innerHTML = `
            <button type="button" class="btn btn-secondary btn-sm" data-footer-act="close">关闭</button>
            <button type="button" class="btn btn-secondary btn-sm" data-footer-act="rerun">使用相同参数再次运行</button>
            <button type="button" class="btn btn-primary btn-sm" data-footer-act="artifacts">查看全部产出</button>`
        } else {
          footerEl.innerHTML = `
            <button type="button" class="btn btn-secondary btn-sm" data-footer-act="close">终止并关闭</button>
            <button type="button" class="btn btn-secondary btn-sm" data-footer-act="rerun">使用相同参数再次运行</button>
            <button type="button" class="btn btn-primary btn-sm" data-footer-act="task">查看任务详情</button>`
        }
      } else {
        footerEl.hidden = true
        footerEl.innerHTML = ''
      }
    }
    if (!runInspect) return
    if (!status || !Object.keys(status).length) return
    const rid = debugSession.runId
    if (debugSession.userPicked && debugSession.inspectRef) {
      if (runInspect.getInspectRef() !== debugSession.inspectRef) {
        runInspect.setRun({
          runId: rid,
          runStatus: status,
          inspectRef: debugSession.inspectRef,
        })
      } else {
        runInspect.updateStatus(status)
      }
    } else {
      runInspect.setRun({ runId: rid, runStatus: status })
      debugSession.inspectRef = runInspect.getInspectRef()
    }
  }

  /** 宽调试工作台：流程树 + 节点检查器 */
  function startExecSession(runId) {
    stopExecSession({ clearNodes: false })
    // Sync runId + parameters to canvas (for DebugPanel)
    workflowCanvas?.setAppMeta?.({
      runId: debugSession?.runId || undefined,
      parameters: debugSession?.lastParams || {},
    })
    // Re-create dock shell when structure upgrades (avoid stale DOM)
    if (debugDockEl && !debugDockEl.classList.contains('wf-debug-dock--bench')) {
      try {
        debugDockEl.remove()
      } catch {}
      debugDockEl = null
    }
    const dock = ensureDebugDockMounted()
    if (!dock) return

    canvasMountEl?.querySelector('.app-wf-studio-center')?.classList.add('has-debug-dock')
    void ensureAgentsCache().then(() => {
      if (debugSession?.runId === runId) renderDebugDockBody()
    })

    const statusLineEl = dock.querySelector('[data-role="status-line"]')
    const barEl = dock.querySelector('[data-role="bar"]')
    const heroMetaEl = dock.querySelector('[data-role="hero-meta"]')
    const pulseEl = dock.querySelector('[data-role="pulse"]')
    const logUpdatedEl = dock.querySelector('[data-role="log-updated"]')
    const btnPause = dock.querySelector('[data-role="btn-pause"]')
    const btnResume = dock.querySelector('[data-role="btn-resume"]')
    const btnCancel = dock.querySelector('[data-role="btn-cancel"]')
    const btnClose = dock.querySelector('[data-role="btn-close"]')

    btnClose.addEventListener('click', () => collapseDebugDock())

    let controlBusy = false
    let notifiedTerminal = false
    let lastPollAt = Date.now()
    async function withControl(fn) {
      if (controlBusy) return
      controlBusy = true
      try {
        await fn()
        await pollStatus()
      } catch (e) {
        toast.error((e && e.message) || String(e))
      } finally {
        controlBusy = false
      }
    }
    btnPause.addEventListener('click', () => withControl(() => api.pauseAppRun(runId)))
    btnResume.addEventListener('click', () => withControl(() => api.resumeAppRun(runId)))
    btnCancel.addEventListener('click', async () => {
      const ok = await showConfirm('确定终止本次运行？后台执行将停止。')
      if (!ok) return
      await withControl(() => api.cancelAppRun(runId))
    })

    function syncControlButtons(overall) {
      const flags = appRunControlFlags(overall)
      btnPause.hidden = !flags.canPause
      btnResume.hidden = !flags.canResume
      btnCancel.hidden = !flags.canCancel
      pulseEl?.classList.toggle('is-live', !flags.isTerminal)
    }

    function countSteps(subtaskStatus) {
      const refs = (appData?.plan?.steps || []).map((s, i) => String(s.ref || i + 1))
      const done = refs.filter((r) =>
        ['completed', 'done', 'success', 'skipped', 'skip', 'cancelled', 'canceled'].includes(
          String(subtaskStatus?.[r] || '').toLowerCase(),
        ),
      ).length
      const running = refs.filter((r) =>
        ['executing', 'running', 'active', 'in_progress'].includes(
          String(subtaskStatus?.[r] || '').toLowerCase(),
        ),
      ).length
      return { done, total: refs.length, running }
    }

    function runElapsedLabel(status) {
      const start = status?.started_at
        ? Date.parse(String(status.started_at))
        : status?.created_at
          ? Date.parse(String(status.created_at))
          : NaN
      if (!Number.isFinite(start)) return ''
      const end = ['completed', 'failed', 'cancelled', 'canceled'].includes(
        String(status?.status || '').toLowerCase(),
      )
        ? status?.completed_at
          ? Date.parse(String(status.completed_at))
          : Date.now()
        : Date.now()
      if (!Number.isFinite(end) || end < start) return ''
      return formatDurationMs(end - start)
    }

    function updateHero(status) {
      const overall = status.status || 'running'
      let progress = Math.min(100, Math.max(0, Number(status.progress) || 0))
      if (overall === 'completed') progress = 100
      const meta = STATUS_META[overall] || STATUS_META.unknown
      const { done, total, running } = countSteps(status.subtask_status || {})
      const elapsed = runElapsedLabel(status)
      const phase = currentPhaseText(appData?.plan?.steps || [], status.subtask_status || {}, overall)

      if (statusLineEl) {
        if (overall === 'completed') statusLineEl.textContent = '✓ 调试完成'
        else if (overall === 'failed') statusLineEl.textContent = '调试失败'
        else if (overall === 'paused') statusLineEl.textContent = 'Ⅱ 已暂停'
        else if (running >= 2) statusLineEl.textContent = `● 并行执行中 · ${running} 个节点正在运行`
        else statusLineEl.textContent = `● ${meta.label}`
      }
      if (barEl) {
        // Prefer node completion ratio when available; fall back to server progress
        const ratio = total > 0 ? Math.round((done / total) * 100) : progress
        barEl.style.width = `${Math.max(progress, ratio)}%`
      }
      if (heroMetaEl) {
        const parts = []
        if (elapsed) parts.push(overall === 'completed' ? `总耗时 ${elapsed}` : `已运行 ${elapsed}`)
        if (total) {
          if (overall === 'completed') parts.push(`${done}/${total} 节点成功`)
          else if (overall === 'failed') parts.push(`${done}/${total} 节点成功`)
          else parts.push(`${done}/${total} 节点`)
        }
        if (phase && !['completed', 'failed', 'cancelled', 'canceled'].includes(overall)) {
          parts.push(phase)
        }
        heroMetaEl.textContent = parts.join(' · ') || '准备中…'
      }
      if (logUpdatedEl) {
        const ago = Math.max(0, Math.round((Date.now() - lastPollAt) / 1000))
        logUpdatedEl.textContent = ago <= 1 ? '上次更新：刚刚' : `上次更新：${ago} 秒前`
      }
      dock?.classList.toggle('is-done', overall === 'completed')
      dock?.classList.toggle('is-failed', overall === 'failed')
      syncControlButtons(overall)
      return { overall, progress }
    }

    async function pollStatus() {
      try {
        const status = await api.getAppRunStatus(runId)
        if (!status) return
        lastPollAt = Date.now()
        if (debugSession?.runId === runId) debugSession.status = status
        if (status.task_id && debugSession?.runId === runId) debugSession.taskId = status.task_id

        const { overall } = updateHero(status)

        workflowCanvas?.setExecStatus?.(
          buildExecMapFromStatus(appData, status.subtask_status || {}),
        )
        if (debugDockEl && !debugDockEl.classList.contains('is-collapsed')) {
          renderDebugDockBody()
          void syncStepLog()
        }

        if (['completed', 'failed', 'cancelled'].includes(overall)) {
          if (execPollTimer) {
            clearInterval(execPollTimer)
            execPollTimer = null
          }
          setTimeout(() => {
            if (debugSession?.runId !== runId) return
            void (async () => {
              try {
                const late = await api.getAppRunStatus(runId)
                if (late && debugSession?.runId === runId) {
                  debugSession.status = late
                  if (late.task_id) debugSession.taskId = late.task_id
                  lastPollAt = Date.now()
                  updateHero(late)
                  workflowCanvas?.setExecStatus?.(
                    buildExecMapFromStatus(appData, late.subtask_status || {}),
                  )
                  if (debugDockEl && !debugDockEl.classList.contains('is-collapsed')) {
                    renderDebugDockBody()
                    void syncStepLog()
                  }
                }
              } catch {
                /* ignore */
              }
            })()
          }, 2000)
          if (!notifiedTerminal) {
            notifiedTerminal = true
            if (overall === 'completed') {
              toast.success('运行完成 · 可在调试工作台查看结果')
              void notifyDesktopCompletion({
                title: '工作流运行完成',
                body: appData?.name || '工作流',
                tag: `app-run-${runId}`,
              })
            } else if (overall === 'failed') {
              toast.error('运行失败: ' + (status.error || ''))
              void notifyDesktopCompletion({
                title: '工作流运行失败',
                body: String(status.error || appData?.name || '工作流'),
                tag: `app-run-${runId}`,
              })
            } else {
              toast.info('运行已取消')
            }
          }
        }
      } catch {
        /* keep polling */
      }
    }

    renderDebugDockBody()
    pollStatus()
    execPollTimer = setInterval(pollStatus, 2500)
  }

  // ─── API 访问（OpenAI 兼容）───

  async function showApiAccessModal() {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="wf-history-panel wf-api-access-panel" role="dialog" aria-label="API 访问">
        <div class="wf-history-panel-head">
          <h3 class="wf-history-panel-title">API 访问</h3>
          <button type="button" class="wf-history-close" aria-label="关闭">✕</button>
        </div>
        <div class="wf-history-panel-body" data-role="api-body">
          <div class="wf-history-empty">加载中…</div>
        </div>
      </div>
    `
    document.body.appendChild(overlay)
    const body = overlay.querySelector('[data-role="api-body"]')
    const closeFn = () => overlay.remove()
    overlay.querySelector('.wf-history-close').addEventListener('click', closeFn)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeFn()
    })

    const copyText = async (text) => {
      try {
        await navigator.clipboard.writeText(text)
        toast.success('已复制')
      } catch {
        toast.error('复制失败，请手动选择')
      }
    }

    const resolveOpenAiBase = async () => {
      const gw = (await getGatewayBaseUrl()) || ''
      const root = (gw || window.location.origin || '').replace(/\/+$/, '')
      return `${root}/v1`
    }

    let plaintextOnce = ''
    /** @type {Record<string, string>} */
    let draftVars = buildExampleVariables(appData || {})

    const paramDefs = () =>
      (Array.isArray(appData?.parameters) ? appData.parameters : []).filter(
        (p) => String(p?.name || '').trim(),
      )

    const currentBody = () =>
      buildExampleChatRequest({
        appId,
        app: appData,
        variables: draftVars,
        detail: true,
      })

    const renderParamRows = () => {
      const rows = paramDefs()
      if (!rows.length) {
        return `<div class="wf-api-call-empty">本工作流无运行参数，直接复制下方请求即可调用。</div>`
      }
      return `<div class="wf-api-call-params">
        ${rows
          .map((p) => {
            const name = String(p.name || '').trim()
            const label = String(p.label || name).trim()
            const required = !!p.required
            const ptype = String(p.type || 'text').toLowerCase()
            const desc = String(p.description || '').trim()
            const val = draftVars[name] ?? ''
            const opts = Array.isArray(p.options) ? p.options : []
            let control = ''
            if (ptype === 'select' && opts.length) {
              control = `<select data-param="${escHtml(name)}">
                ${opts
                  .map((o) => {
                    const ov = String(o ?? '')
                    return `<option value="${escHtml(ov)}" ${
                      ov === val ? 'selected' : ''
                    }>${escHtml(ov)}</option>`
                  })
                  .join('')}
              </select>`
            } else if (ptype === 'textarea') {
              control = `<textarea rows="2" data-param="${escHtml(name)}">${escHtml(val)}</textarea>`
            } else {
              control = `<input type="${
                ptype === 'number' ? 'number' : 'text'
              }" data-param="${escHtml(name)}" value="${escHtml(val)}" />`
            }
            return `<label class="wf-api-call-param">
              <span class="wf-api-call-param-meta">
                <span class="wf-api-call-param-name">${escHtml(label)}
                  <code>${escHtml(name)}</code>
                  ${required ? '<em class="is-req">必填</em>' : '<em>可选</em>'}
                </span>
                ${desc ? `<span class="wf-api-call-param-desc">${escHtml(desc)}</span>` : ''}
              </span>
              ${control}
            </label>`
          })
          .join('')}
      </div>`
    }

    const renderBody = async () => {
      const openAiBase = await resolveOpenAiBase()
      const status = String(appData?.status || 'draft')
      const isPublished = status === 'published'
      let keys
      try {
        const listed = await api.listAppKeys(appId)
        keys = listed.keys || []
      } catch (e) {
        body.innerHTML = `<div class="wf-history-empty wf-history-empty--error">加载 Key 失败: ${escHtml(e.message)}</div>`
        return
      }

      const keyPlaceholder = plaintextOnce || 'ef-YOUR_API_KEY'
      const reqBody = currentBody()
      const curlSync = buildCurlSync({
        baseUrl: openAiBase,
        apiKey: keyPlaceholder,
        body: reqBody,
      })
      const curlAsync = buildCurlAsync({
        baseUrl: openAiBase,
        apiKey: keyPlaceholder,
        body: reqBody,
      })
      const py = buildPythonSdk({
        baseUrl: openAiBase,
        apiKey: keyPlaceholder,
        appId,
        variables: reqBody.variables,
        userMessage: reqBody.messages?.[0]?.content || '',
      })
      const prodEnv = `# EvoFlow App OpenAPI
EVOFLOW_OPENAI_BASE_URL=${openAiBase}
EVOFLOW_OPENAI_API_KEY=${keyPlaceholder}
EVOFLOW_OPENAI_MODEL=${appId}
# GET $EVOFLOW_OPENAI_BASE_URL/models  → example_request / example_response`

      const bodyJson = JSON.stringify(reqBody, null, 2)
      const exampleResp = buildExampleChatResponse({
        appId,
        app: appData,
        detail: true,
      })
      const respJson = JSON.stringify(exampleResp, null, 2)
      const contractJson = JSON.stringify(buildResponseContractSummary(), null, 2)

      body.innerHTML = `
        <p class="wf-api-access-hint">
          发布后用 App Key 调 <code>/v1/chat/completions</code>（兼容壳，非完整 OpenAI）。
          多 Agent 读 <code>responseData[].assigned_agent</code>。
          ${
            isPublished
              ? '<span class="app-card-badge is-published">已发布</span>'
              : '<span class="app-card-badge is-draft">草稿</span> 须先发布才能创建 Key。'
          }
        </p>
        ${
          !isPublished
            ? `<div class="wf-api-publish-cta">
            <button type="button" class="btn btn-primary" data-role="do-publish">先发布</button>
          </div>`
            : ''
        }

        <section class="wf-api-call-card" data-role="call-card">
          <div class="wf-api-call-card-head">
            <div>
              <h4>调用示例（改参即可跑通）</h4>
              <p>按本工作流参数生成；改下面的值后，复制内容就是完整请求。</p>
            </div>
            <div class="wf-api-call-actions">
              <button type="button" class="btn btn-xs btn-primary" data-role="copy-json">复制请求体</button>
              <button type="button" class="btn btn-xs btn-secondary" data-role="copy-curl">复制 curl</button>
              <button type="button" class="btn btn-xs btn-ghost" data-role="copy-py">复制 Python</button>
              <button type="button" class="btn btn-xs btn-ghost" data-role="reset-vars" title="恢复示例默认值">重置</button>
            </div>
          </div>
          <div class="wf-api-call-meta">
            <div><span>POST</span><code>${escHtml(openAiBase)}/chat/completions</code>
              <button type="button" class="btn btn-xs btn-ghost" data-role="copy-base">复制 Base</button></div>
            <div><span>model</span><code>${escHtml(appId)}</code></div>
            <div><span>Key</span><code>${escHtml(keyPlaceholder)}</code>
              ${
                plaintextOnce
                  ? ''
                  : '<em class="wf-api-call-key-hint">创建 Key 后示例会自动带上明文</em>'
              }</div>
          </div>
          ${renderParamRows()}
          <details class="wf-api-call-preview" open>
            <summary>请求体预览</summary>
            <pre data-role="body-json">${escHtml(bodyJson)}</pre>
          </details>
          <details class="wf-api-call-preview" open>
            <summary>结果结构（detail=true 示例）</summary>
            <p class="wf-api-call-resp-hint">
              答案读 <code>choices[0].message.content</code>；
              多 Agent 读 <code>responseData[].assigned_agent</code> + <code>result_summary</code>。
              <button type="button" class="btn btn-xs btn-ghost" data-role="copy-resp">复制示例响应</button>
              <button type="button" class="btn btn-xs btn-ghost" data-role="copy-contract">复制字段说明</button>
            </p>
            <pre data-role="resp-json">${escHtml(respJson)}</pre>
            <div class="wf-api-snippet-label" style="margin-top:8px">字段速查</div>
            <pre data-role="contract-json">${escHtml(contractJson)}</pre>
          </details>
          <details class="wf-api-call-preview">
            <summary>curl / Python / 异步</summary>
            <div class="wf-api-snippet">
              <div class="wf-api-snippet-label">同步 curl</div>
              <pre data-role="curl-ex">${escHtml(curlSync)}</pre>
            </div>
            <div class="wf-api-snippet">
              <div class="wf-api-snippet-label">异步 curl</div>
              <pre data-role="async-ex">${escHtml(curlAsync)}</pre>
              <button type="button" class="btn btn-xs btn-ghost" data-role="copy-async" style="margin-top:6px">复制 async</button>
            </div>
            <div class="wf-api-snippet">
              <div class="wf-api-snippet-label">OpenAI Python SDK</div>
              <pre data-role="py-ex">${escHtml(py)}</pre>
            </div>
          </details>
        </section>

        <div class="wf-api-base-row" style="margin-top:14px">
          <label>生产配置</label>
          <button type="button" class="btn btn-xs btn-secondary" data-role="copy-prod">复制 .env</button>
        </div>
        <div class="wf-api-snippet">
          <pre data-role="prod-ex">${escHtml(prodEnv)}</pre>
        </div>

        ${
          plaintextOnce
            ? `<div class="wf-api-plaintext">
            <div class="wf-api-plaintext-label">新建 Key（仅显示一次，请立即保存）</div>
            <code data-role="plaintext">${escHtml(plaintextOnce)}</code>
            <div style="margin-top:8px">
              <button type="button" class="btn btn-xs btn-primary" data-role="copy-plaintext">复制 Key</button>
            </div>
          </div>`
            : ''
        }
        <div class="wf-api-keys-head">
          <h4>API Keys</h4>
          <button type="button" class="btn btn-xs btn-secondary" data-role="create-key" ${
            isPublished ? '' : 'disabled title="请先发布工作流"'
          }>创建 Key</button>
        </div>
        <div data-role="keys-list">
          ${
            keys.length
              ? keys
                  .map(
                    (k) => `
            <div class="wf-api-key-item" data-hash="${escHtml(k.token_hash)}">
              <div class="wf-api-key-meta">
                <div class="wf-api-key-name">${escHtml(k.name || 'default')}${
                      k.pinned_version != null
                        ? ` <span class="app-card-badge is-published">v${escHtml(String(k.pinned_version))}</span>`
                        : ''
                    }</div>
                <div class="wf-api-key-hash">${escHtml(String(k.token_hash || '').slice(0, 16))}…</div>
              </div>
              <button type="button" class="btn btn-xs btn-ghost" data-role="revoke-key" data-hash="${escHtml(k.token_hash)}">撤销</button>
            </div>`,
                  )
                  .join('')
              : `<div class="wf-history-empty"><p>${
                  isPublished ? '尚未创建 Key' : '发布后方可创建 Key'
                }</p></div>`
          }
        </div>
        <p class="wf-api-access-hint wf-api-access-hint--muted">
          对方也可 <code>GET ${escHtml(openAiBase)}/models</code> 取
          <code>evoflow.example_request</code> /
          <code>evoflow.example_response</code> /
          <code>evoflow.response_contract</code>。
        </p>
      `

      const syncPreviews = () => {
        const next = currentBody()
        const json = JSON.stringify(next, null, 2)
        const curl = buildCurlSync({
          baseUrl: openAiBase,
          apiKey: keyPlaceholder,
          body: next,
        })
        const asyncCurl = buildCurlAsync({
          baseUrl: openAiBase,
          apiKey: keyPlaceholder,
          body: next,
        })
        const pyNext = buildPythonSdk({
          baseUrl: openAiBase,
          apiKey: keyPlaceholder,
          appId,
          variables: next.variables,
          userMessage: next.messages?.[0]?.content || '',
        })
        const elJson = body.querySelector('[data-role="body-json"]')
        const elCurl = body.querySelector('[data-role="curl-ex"]')
        const elAsync = body.querySelector('[data-role="async-ex"]')
        const elPy = body.querySelector('[data-role="py-ex"]')
        if (elJson) elJson.textContent = json
        if (elCurl) elCurl.textContent = curl
        if (elAsync) elAsync.textContent = asyncCurl
        if (elPy) elPy.textContent = pyNext
      }

      const readDraftFromForm = () => {
        body.querySelectorAll('[data-param]').forEach((el) => {
          const name = el.getAttribute('data-param')
          if (!name) return
          draftVars[name] = String(el.value ?? '')
        })
      }

      body.querySelectorAll('[data-param]').forEach((el) => {
        el.addEventListener('input', () => {
          readDraftFromForm()
          syncPreviews()
        })
        el.addEventListener('change', () => {
          readDraftFromForm()
          syncPreviews()
        })
      })

      body.querySelector('[data-role="do-publish"]')?.addEventListener('click', async () => {
        closeFn()
        try {
          await workflowCanvas?.publishApp?.()
        } catch (e) {
          toast.error('发布失败: ' + (e?.message || e))
        }
      })
      body.querySelector('[data-role="copy-base"]')?.addEventListener('click', () =>
        copyText(openAiBase),
      )
      body.querySelector('[data-role="copy-prod"]')?.addEventListener('click', () =>
        copyText(prodEnv),
      )
      body.querySelector('[data-role="copy-plaintext"]')?.addEventListener('click', () =>
        copyText(plaintextOnce),
      )
      body.querySelector('[data-role="copy-json"]')?.addEventListener('click', () => {
        readDraftFromForm()
        copyText(JSON.stringify(currentBody(), null, 2))
      })
      body.querySelector('[data-role="copy-resp"]')?.addEventListener('click', () =>
        copyText(respJson),
      )
      body.querySelector('[data-role="copy-contract"]')?.addEventListener('click', () =>
        copyText(contractJson),
      )
      body.querySelector('[data-role="copy-curl"]')?.addEventListener('click', () => {
        readDraftFromForm()
        copyText(
          buildCurlSync({
            baseUrl: openAiBase,
            apiKey: keyPlaceholder,
            body: currentBody(),
          }),
        )
      })
      body.querySelector('[data-role="copy-async"]')?.addEventListener('click', () => {
        readDraftFromForm()
        copyText(
          buildCurlAsync({
            baseUrl: openAiBase,
            apiKey: keyPlaceholder,
            body: currentBody(),
          }),
        )
      })
      body.querySelector('[data-role="copy-py"]')?.addEventListener('click', () => {
        readDraftFromForm()
        const next = currentBody()
        copyText(
          buildPythonSdk({
            baseUrl: openAiBase,
            apiKey: keyPlaceholder,
            appId,
            variables: next.variables,
            userMessage: next.messages?.[0]?.content || '',
          }),
        )
      })
      body.querySelector('[data-role="reset-vars"]')?.addEventListener('click', () => {
        draftVars = buildExampleVariables(appData || {})
        void renderBody()
      })
      body.querySelector('[data-role="create-key"]')?.addEventListener('click', async () => {
        if (!isPublished) {
          toast.warning('请先发布工作流')
          return
        }
        try {
          const created = await api.createAppKey(appId, { name: 'api' })
          plaintextOnce = String(created?.token || '')
          toast.success('Key 已创建（仅显示一次）')
          await renderBody()
        } catch (e) {
          toast.error('创建失败: ' + (e?.message || e))
        }
      })
      body.querySelectorAll('[data-role="revoke-key"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const hash = btn.getAttribute('data-hash')
          if (!hash) return
          const ok = await showConfirm('确定撤销该 API Key？撤销后使用该 Key 的调用将立即失败。')
          if (!ok) return
          try {
            await api.revokeAppKey(appId, hash)
            toast.success('已撤销')
            await renderBody()
          } catch (e) {
            toast.error('撤销失败: ' + (e?.message || e))
          }
        })
      })
    }

    await renderBody()
  }

  // ─── 版本历史面板 ───

  async function showRevisionsModal() {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="wf-history-panel" role="dialog" aria-label="版本历史">
        <div class="wf-history-panel-head">
          <h3 class="wf-history-panel-title">版本历史</h3>
          <button type="button" class="wf-history-close" aria-label="关闭">✕</button>
        </div>
        <div class="wf-history-panel-body" data-role="rev-body">
          <div class="wf-history-empty">加载中…</div>
        </div>
      </div>
    `
    document.body.appendChild(overlay)

    const closeBtn = overlay.querySelector('.wf-history-close')
    const body = overlay.querySelector('[data-role="rev-body"]')
    const closeFn = () => overlay.remove()
    closeBtn.addEventListener('click', closeFn)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeFn() })

    try {
      const revs = await api.listAppRevisions(appId, 50)
      if (!revs || revs.length === 0) {
        body.innerHTML = `
          <div class="wf-history-empty">
            <p>暂无版本快照（保存工作流后会出现）</p>
          </div>
        `
        return
      }

      const currentVer = Number(appData?.version || 0)
      body.innerHTML = revs.map((rev) => {
        const ver = Number(rev.version)
        const created = rev.created_at ? new Date(rev.created_at).toLocaleString('zh-CN') : ''
        const isCurrent = ver === currentVer
        const note = rev.note ? escHtml(rev.note) : ''
        return `
          <div class="wf-history-item" data-version="${ver}">
            <span class="wf-history-status ${isCurrent ? 'completed' : 'pending'}">v${ver}${isCurrent ? ' 当前' : ''}</span>
            <div class="wf-history-item-main" style="cursor:default">
              <div class="wf-history-item-params">${created || '未知时间'}</div>
              <div class="wf-history-item-meta">${note || '无备注'}</div>
            </div>
            <div class="wf-history-item-actions">
              <button type="button" class="btn btn-xs btn-ghost wf-rev-view" data-version="${ver}">查看</button>
              ${isCurrent ? '' : `<button type="button" class="btn btn-xs btn-secondary wf-rev-restore" data-version="${ver}">恢复</button>`}
            </div>
          </div>
        `
      }).join('')

      body.querySelectorAll('.wf-rev-view').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const ver = Number(btn.dataset.version)
          try {
            const detail = await api.getAppRevision(appId, ver)
            const snap = detail?.snapshot || detail || {}
            const stepN = Array.isArray(snap.steps) ? snap.steps.length : 0
            const paramN = Array.isArray(snap.parameters) ? snap.parameters.length : 0
            showModal({
              title: `版本 v${ver} 摘要`,
              width: 520,
              fields: [
                { name: 'name', label: '名称', value: snap.name || '', readonly: true },
                { name: 'goal', label: '目标模板', type: 'textarea', rows: 2, value: snap.goal_template || '', readonly: true },
                {
                  name: 'summary',
                  label: '摘要',
                  value: `${stepN} 步骤 · ${paramN} 参数 · ${executionModeLabel(snap.execution_mode)}`,
                  readonly: true,
                },
              ],
              onConfirm: () => {},
            })
          } catch (e) {
            toast.error('加载版本失败: ' + (e?.message || e))
          }
        })
      })
      body.querySelectorAll('.wf-rev-restore').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const ver = Number(btn.dataset.version)
          const ok = await showConfirm(
            `将恢复 v${ver} 的定义为当前草稿（写入新版本号，旧快照保留）。继续？`,
          )
          if (!ok) return
          try {
            if (workflowCanvas?.isDirty?.()) {
              const discard = await showConfirm('画布有未保存修改，恢复将丢弃本地改动。继续？')
              if (!discard) return
            }
            await api.restoreAppRevision(appId, ver)
            toast.success(`已恢复 v${ver} -> 新草稿，需重新发布才能对外调用`)
            closeFn()
            appData = await api.getApp(appId)
            updateHeader()
            mountCanvas()
          } catch (e) {
            toast.error('恢复失败: ' + (e?.message || e))
          }
        })
      })
    } catch (e) {
      body.innerHTML = `<div class="wf-history-empty wf-history-empty--error">加载失败: ${escHtml(e.message)}</div>`
    }
  }

  // ─── 应用设置（三模块：基础信息 / 执行设置 / 运行参数）───

  function buildDescFromGoal(goal) {
    const g = String(goal || '').trim().replace(/\s+/g, ' ')
    if (!g) return ''
    const core = g.length > 180 ? `${g.slice(0, 177)}…` : g
    return `本工作流用于完成：${core}`
  }

  function showSettingsModal() {
    const goalInit = workflowCanvas?.getGoal?.() || appData.plan?.goal || ''
    const mode = appData.execution_mode || 'workflow'
    const descInit = String(appData.description || '').trim()
    const descOpen = Boolean(descInit)
    const overlay = showContentModal({
      title: '工作流设置',
      subtitle: '配置工作流目标、执行方式和运行参数',
      width: 740,
      className: 'app-settings-modal',
      overlayClass: 'app-settings-overlay',
      content: `
        <div class="app-settings">
          <section class="app-settings-section">
            <h3 class="app-settings-section-title">基础信息</h3>
            <div class="app-settings-field">
              <label class="app-settings-label" for="app-settings-goal">工作流目标 <span class="app-settings-req">*</span></label>
              <textarea class="form-input app-settings-input" id="app-settings-goal" data-name="goal" rows="3" maxlength="500" placeholder="用一句话说明这个工作流要完成什么">${escHtml(goalInit)}</textarea>
              <div class="app-settings-counter"><span data-role="goal-count">${String(goalInit).length}</span> / 500</div>
            </div>
            <div class="app-settings-fold" data-role="desc-fold"${descOpen ? ' data-open="1"' : ''}>
              <button type="button" class="app-settings-fold-toggle" data-act="toggle-desc" aria-expanded="${descOpen ? 'true' : 'false'}">
                <span class="app-settings-fold-chevron" aria-hidden="true"></span>
                <span data-role="desc-toggle-label">${descOpen ? '详细描述' : '添加详细描述'}</span>
              </button>
              <div class="app-settings-fold-body" data-role="desc-body"${descOpen ? '' : ' hidden'}>
                <textarea class="form-input app-settings-input" data-name="description" rows="3" placeholder="补充说明、使用场景或注意事项（可选）">${escHtml(descInit)}</textarea>
                <div class="app-settings-desc-actions">
                  <button type="button" class="btn btn-ghost btn-xs" data-act="gen-desc">根据工作流目标自动生成</button>
                  <button type="button" class="btn btn-ghost btn-xs" data-act="regen-desc">重新生成</button>
                </div>
              </div>
            </div>
          </section>

          <section class="app-settings-section">
            <h3 class="app-settings-section-title">执行设置</h3>
            <div class="app-settings-field">
              <div class="app-settings-label">执行方式 <span class="app-settings-req">*</span></div>
              <div class="app-settings-mode-grid" role="radiogroup" aria-label="执行方式">
                <label class="app-settings-mode-card${mode !== 'lead_supervised' ? ' is-selected' : ''}">
                  <input type="radio" name="execution_mode" data-name="execution_mode" value="workflow"${mode !== 'lead_supervised' ? ' checked' : ''}>
                  <span class="app-settings-mode-title">按步骤自动跑完</span>
                  <span class="app-settings-mode-desc">推荐，工作流将自动执行全部步骤</span>
                </label>
                <label class="app-settings-mode-card${mode === 'lead_supervised' ? ' is-selected' : ''}">
                  <input type="radio" name="execution_mode" data-name="execution_mode" value="lead_supervised"${mode === 'lead_supervised' ? ' checked' : ''}>
                  <span class="app-settings-mode-title">先确认计划再执行</span>
                  <span class="app-settings-mode-desc">适合高风险任务，生成计划后需人工确认</span>
                </label>
              </div>
            </div>
            <label class="app-settings-check">
              <input type="checkbox" data-name="auto_run"${appData.auto_run ? ' checked' : ''}>
              <span>
                <span class="app-settings-check-title">调度触发时自动执行</span>
                <span class="app-settings-check-desc">开启后，定时或接口触发时无需人工确认</span>
              </span>
            </label>
          </section>

          <section class="app-settings-section app-settings-section--params">
            <div id="app-settings-params-root"></div>
          </section>
        </div>
      `,
      buttons: [{ label: '保存设置', className: 'btn btn-primary btn-sm', id: 'btn-app-settings-save' }],
    })

    const paramsCtl = mountParamsEditor(
      overlay.querySelector('#app-settings-params-root'),
      appData.parameters || [],
    )

    const baseClose = overlay.close.bind(overlay)
    overlay.close = () => {
      paramsCtl.destroy()
      baseClose()
    }

    const goalEl = overlay.querySelector('[data-name="goal"]')
    const goalCount = overlay.querySelector('[data-role="goal-count"]')
    const descBody = overlay.querySelector('[data-role="desc-body"]')
    const descToggle = overlay.querySelector('[data-act="toggle-desc"]')
    const descLabel = overlay.querySelector('[data-role="desc-toggle-label"]')
    const descEl = overlay.querySelector('[data-name="description"]')

    goalEl?.addEventListener('input', () => {
      if (goalCount) goalCount.textContent = String(goalEl.value.length)
    })

    const setDescOpen = (open) => {
      if (!descBody || !descToggle) return
      descBody.hidden = !open
      descToggle.setAttribute('aria-expanded', open ? 'true' : 'false')
      if (descLabel) descLabel.textContent = open ? '详细描述' : '添加详细描述'
      overlay.querySelector('[data-role="desc-fold"]')?.toggleAttribute('data-open', open)
    }

    descToggle?.addEventListener('click', () => {
      setDescOpen(descBody?.hidden)
    })

    const fillDescFromGoal = () => {
      const goal = String(goalEl?.value || '').trim()
      if (!goal) {
        toast.warning('请先填写工作流目标')
        goalEl?.focus()
        return
      }
      setDescOpen(true)
      if (descEl) {
        descEl.value = buildDescFromGoal(goal)
        descEl.focus()
      }
    }

    overlay.querySelector('[data-act="gen-desc"]')?.addEventListener('click', fillDescFromGoal)
    overlay.querySelector('[data-act="regen-desc"]')?.addEventListener('click', fillDescFromGoal)

    overlay.querySelectorAll('.app-settings-mode-card').forEach((card) => {
      const input = card.querySelector('input[type="radio"]')
      input?.addEventListener('change', () => {
        overlay.querySelectorAll('.app-settings-mode-card').forEach((c) => {
          c.classList.toggle('is-selected', c.querySelector('input')?.checked)
        })
      })
    })

    overlay.querySelector('#btn-app-settings-save')?.addEventListener('click', async () => {
      const goal = String(overlay.querySelector('[data-name="goal"]')?.value || '').trim()
      if (!goal) {
        toast.warning('请填写工作流目标')
        goalEl?.focus()
        return
      }
      const description = String(overlay.querySelector('[data-name="description"]')?.value || '').trim()
      const execution_mode =
        overlay.querySelector('[data-name="execution_mode"]:checked')?.value || 'workflow'
      const auto_run = !!overlay.querySelector('[data-name="auto_run"]')?.checked
      const parameters = paramsCtl.collect()
      const bad = parameters.find((p) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p.name))
      if (bad) {
        toast.warning(`参数标识「${bad.name || '空'}」须为英文/下划线开头，如 topic、city_name`)
        return
      }
      const dup = parameters.find((p, i) => parameters.findIndex((x) => x.name === p.name) !== i)
      if (dup) {
        toast.warning(`参数标识「${dup.name}」重复，请修改后再保存`)
        return
      }
      try {
        workflowCanvas?.setGoal?.(goal)
        await saveAppMeta({ description, execution_mode, auto_run, parameters })
        if (workflowCanvas?.isDirty?.()) await workflowCanvas.saveDraft()
        else {
          await api.updateApp(appId, {
            plan: {
              goal,
              steps: appData.plan?.steps || [],
              canvas: appData.plan?.canvas || appData.canvas,
            },
          })
        }
        toast.success('设置已保存')
        overlay.close()
      } catch (e) {
        toast.error('保存失败: ' + e.message)
      }
    })
  }

  // 运行历史 / 版本由 WorkflowToolbar 的 onOpenHistory / onOpenVersions 承接

  loadApp()
  return page
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
