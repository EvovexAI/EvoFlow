/**
 * 任务详情页 - 任务观测数据（工作流见 /workflow/:id；主控对话回主对话查看）
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { renderMarkdown } from '../lib/markdown.js'
import {
  formatTaskStatusZh,
  formatUnifiedStatusZh,
  normalizeTaskStatusKey,
  toTaskStatusGroup,
  toUnifiedTaskStatus,
  computeTaskExecutionProgress,
  isTaskPausableStatus,
  isTaskRunningStatus,
  isTaskPlanningStatus,
  isTaskQueuedStatus,
  isTaskWaitingConfirmation,
  isTaskCancellableStatus,
  taskStatusTagClass,
} from '../lib/task-status-label.js'
import { formatCompactNum, formatDurationMs, formatSubtaskObsLine } from '../lib/task-observability-format.js'
import { showModal, showConfirm } from '../components/modal.js'
import { promptSaveTaskAsApp } from '../lib/save-task-as-app.js'
import { mountTaskPlanModalBridge, unmountTaskPlanModalBridge, openTaskPlanModal } from './task-detail-workbench.js'
import { taskDescriptionForDisplay } from '../lib/task-placeholder.js'
import { resolveAssignedAgentDisplayName } from '../lib/tool-display.js'
import { normalizeSubtaskResultForDisplay } from '../lib/subtask-result-display.js'
import { taskSummaryText, renderTaskOutputCardsHtml, renderTaskInputRefsCardsHtml, parseTaskResultSections, resolveTaskOutputItems, taskInputRefsOf } from '../lib/task-summary.js'
import {
  taskHandlersOf,
  normalizeTaskHandlers,
  handlerDisplayName,
  renderHandlersEditorHtml,
  renderHandlersReadonlyHtml,
  collectHandlersFromEditor,
  bindHandlersEditor,
} from '../lib/task-handlers.js'
import { bindTaskOutputCardActions } from '../lib/task-output-preview.js'
import { normalizeTaskSource, formatTaskSourceZh } from '../lib/task-source.js'
import { formatRaisedByLabel } from '../lib/task-raised-by.js'

const DETAIL_RISK_LABEL = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  critical: '极高风险',
}

const DETAIL_ACTION_TYPE_LABEL = {
  code_change: '代码变更',
  analysis: '分析',
  report: '报告',
  task_delegation: '任务委派',
  alert: '告警',
  optimization: '优化',
}

const DETAIL_SOURCE_CHANNEL_ZH = {
  proactive_patrol: '岗位值班',
  proactive_dispatch: '跨岗/派发',
  employee_page: '员工页派发',
  chat_mention: '主聊天 @',
  xiaomi: '小V催办',
  role: '岗位协作',
  manual: '手动',
}

function debugTaskDetailEnabled() {
  try {
    return localStorage.getItem('EVOFLOW_DEBUG_TASK_DETAIL') === '1'
  } catch {
    return false
  }
}

/** 员工任务会话 key：``proactive:{code}:task:{taskId}`` */
function proactiveTaskSessionKey(agentCode, taskId) {
  const code = String(agentCode || '').trim()
  const tid = String(taskId || '')
    .trim()
    .replace(/[:/\\]/g, '-')
  if (!code || !tid) return ''
  return `proactive:${code}:task:${tid}`
}

/** 跳转主聊天并打开指定员工任务会话 */
function openProactiveTaskChat(agentCode, taskId) {
  const sk = proactiveTaskSessionKey(agentCode, taskId)
  if (!sk) {
    toast('无法打开续聊：缺少执行岗位或任务 ID', 'error')
    return
  }
  try {
    sessionStorage.setItem('evopanel_pending_shell_session', sk)
    sessionStorage.setItem('evopanel_pending_shell_task_id', String(taskId || '').trim())
    sessionStorage.removeItem('evopanel_pending_shell_processed')
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(
      new CustomEvent('evopanel:shell-select-session', { detail: { sessionKey: sk } }),
    )
  } catch {
    /* ignore */
  }
  window.location.hash = '#/chat'
}

function logTaskDetail(tag, payload) {
  if (!debugTaskDetailEnabled()) return
  try {
    console.info(`[task-detail][${tag}]`, payload)
  } catch {}
}

/** router 切换路由时调用，停止轮询与事件订阅 */
let _pageCleanup = null
/** 应用编辑器内嵌时的清理（与路由页互斥） */
let _embedCleanup = null

export function cleanup() {
  if (_pageCleanup) {
    try {
      _pageCleanup()
    } catch {}
    _pageCleanup = null
  }
}

function destroyTaskDetailEmbed() {
  if (_embedCleanup) {
    try {
      _embedCleanup()
    } catch {}
    _embedCleanup = null
  }
}

/**
 * 创建任务详情视图（整页与应用内嵌共用同一套 UI / 观测；主控对话仅内嵌调试可选展开）。
 * @param {string} taskId
 * @param {{ mode?: 'page'|'embed', onClose?: () => void }} [opts]
 * @returns {{ page: HTMLElement, destroy: () => void }}
 */
export function createTaskDetailView(taskId, opts = {}) {
  const mode = opts.mode === 'embed' ? 'embed' : 'page'
  const isEmbed = mode === 'embed'

  const page = document.createElement('div')
  page.className = `page task-detail-page${isEmbed ? ' task-detail-page--embed' : ''}`

  // 整页不展示主控对话（内容在主对话里）；应用内嵌调试保留折叠面板
  const conversationHtml = isEmbed ? `
    <div class="task-detail-content task-detail-content--single is-conversation-collapsed" id="task-conversation-section" data-td-panel="logs">
      <div class="task-output-panel task-output-panel--primary">
        <div class="output-header">
          <button type="button" class="task-conv-toggle" id="btn-toggle-conversation" aria-expanded="false">
            <span class="output-title">💬 主控对话</span>
            <span class="task-conv-toggle-hint" data-role="conv-toggle-hint">展开</span>
          </button>
          <button class="btn btn-xs btn-ghost" id="btn-refresh-output" title="刷新对话" hidden>🔄</button>
        </div>
        <div class="output-content" id="conversation-content" hidden>
          <div class="output-empty">暂无对话记录<br><span style="font-size:11px;color:var(--text-tertiary)">主控 Agent 执行后将显示对话</span></div>
        </div>
      </div>
    </div>` : ''

  page.innerHTML = `
    <div class="td-shell">
      <header class="td-topbar">
        <div class="td-topbar-main">
          <button class="btn btn-ghost task-detail-back" id="btn-back" type="button" title="${isEmbed ? '返回画布' : '返回任务列表'}" aria-label="${isEmbed ? '返回画布' : '返回任务列表'}">
            <span>←</span>
          </button>
          <div class="td-title-block">
            <h1 class="td-title" id="task-title">加载中...</h1>
            <p class="td-meta-line" id="task-meta-line" hidden></p>
            <p class="td-status-line" id="task-status-line"></p>
          </div>
        </div>
        <div class="td-topbar-actions">
          <button class="btn btn-warning btn-sm" id="btn-pause" type="button" style="display:none">暂停</button>
          <button class="btn btn-secondary btn-sm" id="btn-cancel-task" type="button" style="display:none">取消</button>
          <button class="btn btn-secondary btn-sm" id="btn-refresh" type="button">刷新</button>
          <div class="td-more" id="td-more">
            <button type="button" class="btn btn-secondary btn-sm td-more-btn" id="btn-td-more" aria-haspopup="menu" aria-expanded="false">⋯ 更多</button>
            <div class="td-more-panel" id="td-more-panel" role="menu" hidden>
              <button type="button" class="td-more-item" role="menuitem" data-more="resume-chat" id="btn-resume-employee-chat" hidden>续聊该任务</button>
              <button type="button" class="td-more-item" role="menuitem" data-more="work-item" id="btn-open-work-item" hidden>打开员工工作项</button>
              <button type="button" class="td-more-item td-more-item--danger" role="menuitem" data-more="delete" id="btn-delete-task">删除任务</button>
            </div>
          </div>
        </div>
      </header>

      <div class="td-status-banner" id="task-status-banner" hidden role="status"></div>

      <div class="td-progress" id="task-progress-wrap" hidden>
        <div class="td-progress-head">
          <span class="td-progress-label" id="task-progress-label">进行中</span>
          <span class="td-progress-value" id="task-progress-value">0%</span>
        </div>
        <div class="td-progress-bar"><div class="td-progress-fill" id="task-progress-fill" style="width:0%"></div></div>
        <div class="td-progress-sub" id="task-progress-sub" hidden></div>
      </div>

      <nav class="td-section-tabs" id="td-section-tabs" aria-label="详情分区">
        <button type="button" class="td-section-tab is-active" data-td-tab="overview">概览</button>
        <button type="button" class="td-section-tab" data-td-tab="logs">执行过程</button>
      </nav>

      <div class="td-layout">
        <main class="td-main">
          <section class="task-decision-panel" id="task-decision-panel" hidden aria-label="待你处理" data-td-panel="overview"></section>
          <section class="td-card" id="task-brief-panel" hidden aria-label="简要说明" data-td-panel="overview"></section>
          <section class="td-exec-timeline" id="task-exec-timeline" hidden aria-label="执行步骤" data-td-panel="overview logs"></section>
          <section class="td-result" id="task-outcome-panel" hidden aria-label="任务结果" data-td-panel="overview"></section>
          <section class="task-obs-panel" id="task-obs-panel" hidden aria-label="执行过程" data-td-panel="logs">
            <header class="task-obs-panel-header">
              <h2 class="task-obs-panel-title" id="task-obs-panel-title">执行过程</h2>
              <span class="task-obs-panel-count" id="task-obs-panel-count"></span>
            </header>
            <div class="task-obs-panel-body" id="task-obs-strip"></div>
          </section>
          ${conversationHtml}
        </main>
        <aside class="td-aside" data-td-panel="overview">
          <section class="td-aside-card" id="task-info"></section>
          <section class="td-aside-card td-aside-card--meta" id="task-meta" hidden></section>
          <div class="task-detail-app-provenance" id="task-app-provenance" hidden></div>
        </aside>
      </div>
    </div>
    <div id="task-plan-modal-host" hidden aria-hidden="true"></div>
  `

  const state = {
    taskId,
    projectId: null,
    task: null,
    subtasks: [],
    facts: [],
    agents: [],
    conversationMessages: [],
    eventSubscription: null,
    outputRefreshInterval: null,
    executionHistory: [],
    currentThreadId: null,
    currentSessionKey: null,
    /** 仅应用内嵌调试可展开主控对话；整页不展示 */
    embedMode: isEmbed,
    conversationExpanded: false,
    detailTab: 'overview',
    /** @type {ReturnType<typeof import('../components/proactive-live-process.js').mountProactiveLiveProcess> | null} */
    workProcessLive: null,
  }

  page.querySelector('#btn-back').addEventListener('click', () => {
    if (isEmbed && typeof opts.onClose === 'function') {
      opts.onClose()
      return
    }
    window.location.hash = '#/tasks'
  })

  page.querySelector('#btn-pause').addEventListener('click', () => {
    handlePauseButton(page, state)
  })

  page.querySelector('#btn-cancel-task')?.addEventListener('click', () => {
    void handleCancelTaskFromDetail(page, state)
  })

  page.querySelector('#td-section-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-td-tab]')
    if (!btn) return
    const next = btn.dataset.tdTab || 'overview'
    // 员工任务：点「执行过程」直接弹窗，不再切到整页日志区
    if (next === 'logs' && canOpenTaskWorkProcessPopup(state.task)) {
      void openTaskWorkProcessPopup(page, state)
      return
    }
    state.detailTab = next
    applyDetailTab(page, state)
  })

  page.querySelector('#task-obs-strip')?.addEventListener('click', (e) => {
    if (!e.target.closest('[data-act="open-work-process"]')) return
    void openTaskWorkProcessPopup(page, state)
  })

  page.querySelector('#btn-refresh').addEventListener('click', async () => {
    await loadTaskDetail(page, state)
    toast('已刷新', 'success')
  })

  const moreBtn = page.querySelector('#btn-td-more')
  const morePanel = page.querySelector('#td-more-panel')
  const closeMore = () => {
    if (morePanel) morePanel.hidden = true
    moreBtn?.setAttribute('aria-expanded', 'false')
  }
  moreBtn?.addEventListener('click', (e) => {
    e.stopPropagation()
    const open = morePanel?.hasAttribute('hidden')
    if (open) {
      morePanel.removeAttribute('hidden')
      moreBtn.setAttribute('aria-expanded', 'true')
    } else {
      closeMore()
    }
  })
  document.addEventListener('click', (e) => {
    if (!page.contains(e.target)) return
    if (!e.target.closest?.('#td-more')) closeMore()
  })

  page.querySelector('#td-more-panel')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-more]')
    if (!btn || btn.hidden) return
    const act = btn.dataset.more
    closeMore()
    if (act === 'work-item') {
      const href = btn.dataset.href
      if (href) window.location.hash = href
    } else if (act === 'resume-chat') {
      openProactiveTaskChat(btn.dataset.agentCode, btn.dataset.taskId)
    } else if (act === 'delete') void handleDeleteTaskFromDetail(page, state)
  })

  page.addEventListener('click', (e) => {
    const resumeBtn = e.target.closest?.('[data-act="resume-employee-chat"]')
    if (!resumeBtn) return
    e.preventDefault()
    openProactiveTaskChat(resumeBtn.dataset.agentCode, resumeBtn.dataset.taskId)
  })

  page.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-act="copy-path"]')
    if (!copyBtn) return
    // Handled by bindTaskOutputCardActions when present on card actions
    if (copyBtn.closest?.('.td-output-cards')) return
    e.preventDefault()
    const path = copyBtn.getAttribute('data-path') || ''
    if (!path) return
    try {
      await navigator.clipboard.writeText(path)
      toast('路径已复制', 'success')
    } catch {
      toast('复制失败', 'error')
    }
  })

  bindTaskOutputCardActions(page, {
    workspaceRoot: () => {
      const t = state.task
      return String(
        page.dataset.workspaceRoot ||
          t?.workspace_path ||
          t?.project_path ||
          t?.local_workspace_root ||
          t?.extra?.workspace_path ||
          '',
      ).trim()
    },
    agentCode: () =>
      String(page.dataset.agentCode || state.task?.assigned_to || '').trim(),
  })

  // Resolve employee workspace for role-sourced tasks (authoritative for preview).
  void (async () => {
    try {
      const code = String(state.task?.assigned_to || '').trim()
      if (code) page.dataset.agentCode = code
      if (!code) return
      const role = await api.proactiveGetRole(code).catch(() => null)
      const ws = String(role?.config?.workspace_path || role?.workspace_path || '').trim()
      if (ws) page.dataset.workspaceRoot = ws
    } catch {
      /* ignore */
    }
  })()

  const planModalHost = page.querySelector('#task-plan-modal-host')
  if (planModalHost) {
    mountTaskPlanModalBridge(planModalHost, { taskId })
  }

  const btnRefreshOutput = page.querySelector('#btn-refresh-output')
  if (btnRefreshOutput) {
    btnRefreshOutput.addEventListener('click', async () => {
      await loadTaskConversation(page, state)
      toast('对话已刷新', 'success')
    })
  }

  const btnToggleConversation = page.querySelector('#btn-toggle-conversation')
  if (btnToggleConversation && isEmbed) {
    btnToggleConversation.addEventListener('click', async () => {
      state.conversationExpanded = !state.conversationExpanded
      syncConversationPanelUi(page, state)
      if (state.conversationExpanded) {
        await loadTaskConversation(page, state)
      }
    })
  }

  void loadTaskDetail(page, state).catch((e) => {
    logTaskDetail('initialLoad:error', { taskId, error: String(e) })
  })

  let destroyed = false
  const releasePageResources = () => {
    if (destroyed) return
    destroyed = true
    if (state.outputRefreshInterval) {
      clearInterval(state.outputRefreshInterval)
      state.outputRefreshInterval = null
    }
    if (state.eventSubscription) {
      state.eventSubscription.close()
      state.eventSubscription = null
    }
    unmountTaskPlanModalBridge()
    if (state.workProcessLive) {
      try {
        state.workProcessLive.destroy()
      } catch {
        /* ignore */
      }
      state.workProcessLive = null
    }
  }

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.removedNodes.forEach((node) => {
        if (node === page || (node.contains && node.contains(page))) {
          releasePageResources()
          observer.disconnect()
        }
      })
    })
  })

  setTimeout(() => {
    if (page.parentNode) {
      observer.observe(page.parentNode, { childList: true, subtree: true })
    }
  }, 0)

  window.addEventListener('beforeunload', releasePageResources, { once: true })

  return {
    page,
    destroy: () => {
      releasePageResources()
      observer.disconnect()
      page.remove()
    },
  }
}

/**
 * 嵌入任务详情到指定容器（应用调试坞等）。
 * @returns {{ destroy: () => void }}
 */
export function mountTaskDetailInto(container, { taskId, onClose } = {}) {
  destroyTaskDetailEmbed()
  const id = String(taskId || '').trim()
  if (!container || !id) {
    return { destroy: () => {} }
  }
  const view = createTaskDetailView(id, { mode: 'embed', onClose })
  container.innerHTML = ''
  container.appendChild(view.page)
  _embedCleanup = () => {
    view.destroy()
  }
  return {
    destroy: () => {
      if (_embedCleanup) {
        _embedCleanup()
        _embedCleanup = null
      }
    },
  }
}

export async function render() {
  cleanup()
  destroyTaskDetailEmbed()
  const taskId = extractTaskId()
  if (!taskId) {
    const page = document.createElement('div')
    page.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-tertiary)">无效的任务 ID，<a href="#/tasks">返回任务列表</a></div>'
    return page
  }

  const view = createTaskDetailView(taskId, { mode: 'page' })
  _pageCleanup = view.destroy
  return view.page
}

function shouldLoadConversation(state) {
  // 整页任务详情不展示主控对话（回主对话看）；仅应用内嵌调试展开时加载
  return !!state.embedMode && !!state.conversationExpanded
}

/** 任务结果：结论 / 产出卡片 / 发现 / 下一步 */
function renderTaskOutcomePanel(page, state) {
  const el = page.querySelector('#task-outcome-panel')
  if (!el) return
  const task = state.task
  if (!task) {
    el.hidden = true
    el.innerHTML = ''
    return
  }
  const group = toTaskStatusGroup(task.status)
  const showResult = ['reviewed', 'completed', 'failed', 'executing', 'paused', 'cancelled'].includes(group)
  if (!showResult) {
    el.hidden = true
    el.innerHTML = ''
    return
  }

  const result = taskSummaryText(task)
  const error = String(task.error || task.error_text || '').trim()
  const sections = parseTaskResultSections(group === 'failed' ? (error || result) : result)
  const outputs = resolveTaskOutputItems(task)
  const inputRefs = taskInputRefsOf(task)
  const agentCode = String(task.assigned_to || '').trim()
  const sourceKey = normalizeTaskSource(task.source)
  const workHref = sourceKey === 'role' && agentCode
    ? `#/proactive/${encodeURIComponent(agentCode)}/work/${encodeURIComponent(state.taskId)}`
    : ''
  const canResumeChat = sourceKey === 'role' && !!agentCode && !!state.taskId

  const cards = []
  const workflow = isWorkflowAppTask(task)
  const { subtaskCount, completedCount } = taskProgressMeta(task, state.subtasks)
  const failedNodes = (state.subtasks || [])
    .filter((s) => toTaskStatusGroup(s?.status) === 'failed')
    .map((s) => String(s?.name || '').trim())
    .filter(Boolean)

  if (group === 'completed' || group === 'reviewed') {
    let headline = sections.conclusion
    if (!headline) {
      if (workflow) headline = '工作流运行完成'
      else if (group === 'reviewed') headline = '员工已交工，等待你确认。'
      else headline = '任务已完成。'
    }
    const bits = []
    if (workflow && subtaskCount > 0) bits.push(`${completedCount} / ${subtaskCount} 个节点全部成功`)
    if (outputs.length) bits.push(`共生成 ${outputs.length} 个产出`)
    if (inputRefs.length) bits.push(`${inputRefs.length} 项上游参考`)
    if (sections.findings.length) bits.push(`${sections.findings.length} 项发现`)
    cards.push(`
      <section class="td-card td-card--result">
        <h2 class="td-card-title">${workflow ? '运行结果' : (group === 'reviewed' ? '交工结果' : '完成结果')}</h2>
        <p class="td-card-lead">${escapeHtml(headline)}</p>
        ${bits.length ? `<p class="td-card-sub">${escapeHtml(bits.join(' · '))}</p>` : ''}
        <div class="td-card-actions">
          ${canResumeChat
            ? `<button type="button" class="btn btn-sm btn-primary" data-act="resume-employee-chat" data-agent-code="${escapeHtml(agentCode)}" data-task-id="${escapeHtml(state.taskId)}">续聊</button>`
            : ''}
          ${workHref ? `<a class="btn btn-sm btn-secondary" href="${workHref}">查看工作项</a>` : ''}
          ${outputs[0] && (/^https?:\/\//i.test(outputs[0].value))
            ? `<a class="btn btn-sm btn-primary" href="${escapeHtml(outputs[0].value)}" target="_blank" rel="noopener noreferrer">查看产出</a>`
            : ''}
        </div>
      </section>`)
  } else if (group === 'failed') {
    const failLead = workflow && failedNodes.length
      ? `「${failedNodes[0]}」节点执行失败${completedCount > 0 ? `，前 ${completedCount} 个节点已成功` : ''}`
      : (error || sections.conclusion || result || '执行失败')
    cards.push(`
      <section class="td-card td-card--fail">
        <h2 class="td-card-title">${workflow ? '工作流运行失败' : '失败原因'}</h2>
        <p class="td-card-lead">${escapeHtml(failLead)}</p>
        ${workflow && error && error !== failLead ? `<p class="td-card-sub">${escapeHtml(error.slice(0, 280))}</p>` : ''}
      </section>`)
  } else if (group === 'cancelled') {
    const lead = sections.conclusion || result || '任务已取消，不再继续推进。'
    cards.push(`
      <section class="td-card">
        <h2 class="td-card-title">关闭说明</h2>
        <p class="td-card-lead">${escapeHtml(lead)}</p>
      </section>`)
  } else if (result || (workflow && subtaskCount > 0)) {
    const lead = workflow && subtaskCount > 0
      ? (sections.conclusion || result?.slice(0, 280) || nodeProgressLabel(completedCount, subtaskCount))
      : (sections.conclusion || result.slice(0, 280))
    cards.push(`
      <section class="td-card">
        <h2 class="td-card-title">当前进展</h2>
        <p class="td-card-lead">${escapeHtml(lead)}</p>
      </section>`)
  }

  if (inputRefs.length) {
    cards.push(`
      <section class="td-card td-card--input-refs">
        <h2 class="td-card-title">上游参考产物</h2>
        <p class="td-card-sub">来自上游交工指定，请先阅读；不是本岗交付物。</p>
        ${renderTaskInputRefsCardsHtml(task, escapeHtml, { enablePreview: true })}
      </section>`)
  }

  if (outputs.length) {
    cards.push(`
      <section class="td-card">
        <h2 class="td-card-title">本岗交付物</h2>
        ${renderTaskOutputCardsHtml(task, escapeHtml, { enablePreview: true })}
      </section>`)
  }

  if (sections.findings.length) {
    cards.push(`
      <section class="td-card">
        <h2 class="td-card-title">关键发现</h2>
        <ul class="td-findings">${sections.findings.slice(0, 12).map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
      </section>`)
  }

  if (sections.nextSteps.length) {
    cards.push(`
      <section class="td-card">
        <h2 class="td-card-title">建议下一步</h2>
        <ol class="td-next-steps">${sections.nextSteps.slice(0, 10).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
      </section>`)
  }

  if (!sections.findings.length && !sections.nextSteps.length && !outputs.length && !inputRefs.length && result
      && (group === 'completed' || group === 'reviewed' || group === 'executing')
      && result.length > 400 && result !== sections.conclusion) {
    cards.push(`
      <details class="td-card td-card--fold">
        <summary>查看完整总结</summary>
        <pre class="td-raw-summary">${escapeHtml(result)}</pre>
      </details>`)
  }

  if (!cards.length) {
    el.hidden = true
    el.innerHTML = ''
    return
  }
  el.hidden = false
  el.innerHTML = cards.join('')
}

/** 去掉「处理：」前缀，长标题取业务名一段 */
function cleanTaskHeroTitle(raw) {
  let s = String(raw || '').trim()
  s = s.replace(/^处理[：:]\s*/u, '')
  const parts = s.split(/\s*[·•|]\s*/).map((p) => p.trim()).filter(Boolean)
  if (parts.length > 1 && parts.slice(1).some((p) => /转交|审核|风险|工程师|岗位/.test(p))) {
    return parts[0] || s
  }
  return s
}

/** 展示层：把验收长文排成列表，抽出文档链接；不改原文语义 */
function formatHandoffAcceptanceHtml(raw) {
  const text = String(raw || '').trim()
  if (!text) return { bodyHtml: '<p class="td-handoff-empty">（未写验收内容）</p>', docs: [] }

  const docs = []
  let working = text
  working = working.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => {
    docs.push({ label: String(label).trim() || url, url })
    return '\n'
  })
  working = working.replace(/https?:\/\/[^\s)\]>'"]+/g, (url) => {
    docs.push({ label: url, url })
    return '\n'
  })

  const lines = working
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  const items = []
  const paras = []
  for (const line of lines) {
    const bullet = line.replace(/^[-*•]\s+/, '').replace(/^\d+[.)、]\s*/, '')
    const isBullet = bullet !== line || /^[-*•]/.test(line) || /^\d+[.)、]/.test(line)
    let html = escapeHtml(isBullet ? bullet : line)
    html = html.replace(
      /(^|[\s，,：:])(\/[A-Za-z0-9_\-./{}:]+)(?=$|[\s，,。；;])/g,
      (_, pre, path) => `${pre}<code>${path}</code>`,
    )
    html = html.replace(
      /\b((?:npm|pnpm|yarn|npx|uvicorn|python|node|curl|git)\s+[^\n<]+)/g,
      '<code>$1</code>',
    )
    if (isBullet || items.length) {
      if (!isBullet && paras.length === 0 && items.length === 0) {
        paras.push(html)
      } else {
        items.push(html)
      }
    } else {
      paras.push(html)
    }
  }

  // 若几乎都是短句且无列表标记，按换行当列表扫读
  if (!items.length && paras.length >= 3 && paras.every((p) => p.length < 80)) {
    const bodyHtml = `<ul class="td-handoff-list">${paras.map((p) => `<li>${p}</li>`).join('')}</ul>`
    return { bodyHtml, docs }
  }

  const parts = []
  if (paras.length) {
    parts.push(paras.map((p) => `<p class="td-handoff-p">${p}</p>`).join(''))
  }
  if (items.length) {
    parts.push(`<ul class="td-handoff-list">${items.map((p) => `<li>${p}</li>`).join('')}</ul>`)
  }
  return {
    bodyHtml: parts.join('') || `<p class="td-handoff-p">${escapeHtml(text)}</p>`,
    docs,
  }
}

function renderHandoffReviewBodyHtml(task, state, { reviewLocked = false } = {}) {
  const handlers = normalizeTaskHandlers(taskHandlersOf(task))
  const roster = Object.values(state.rolesByCode || {})
  const fromRole = resolveDetailRoleLabel(task, state) || '当前岗位'
  if (!handlers.length) {
    return `
      <div class="task-decision-copy">
        <strong>转交审核</strong>
        <p class="task-decision-missing-handlers">未指定下一岗处理人</p>
      </div>`
  }

  const toNames = handlers.map((h) => handlerDisplayName(h, roster))
  const route = `${fromRole} → ${toNames.join('、')}`
  const blocks = handlers.map((h) => {
    const code = String(h.agent_code || '').trim()
    const name = handlerDisplayName(h, roster)
    const { bodyHtml, docs } = formatHandoffAcceptanceHtml(h.content || '')
    const outs = (h.read_outputs || h.outputs || [])
      .map((o) => {
        const v = String(o?.value || o || '').trim()
        if (!v) return ''
        const label = String(o?.label || '').trim()
        if (/^https?:\/\//i.test(v)) {
          docs.push({ label: label || v, url: v })
          return ''
        }
        return `<li><code>${escapeHtml(v)}</code>${label ? ` · ${escapeHtml(label)}` : ''}</li>`
      })
      .filter(Boolean)
      .join('')
    const uniqDocs = []
    const seen = new Set()
    for (const d of docs) {
      const key = `${d.url}|${d.label}`
      if (seen.has(key)) continue
      seen.add(key)
      uniqDocs.push(d)
    }
    return `
      <div class="td-handoff-assignee-block">
        <div class="td-handoff-k">转交给</div>
        <div class="td-handoff-who">
          <span class="td-handoff-name">${escapeHtml(name)}</span>
          ${code && code !== name ? `<span class="td-handoff-code">${escapeHtml(code)}</span>` : ''}
        </div>
        <div class="td-handoff-k">验收内容</div>
        <div class="td-handoff-acceptance">${bodyHtml}</div>
        ${outs ? `<div class="td-handoff-k">参考产物</div><ul class="td-handoff-refs">${outs}</ul>` : ''}
        ${
          uniqDocs.length
            ? `<div class="td-handoff-k">相关文档</div>
               <ul class="td-handoff-docs">${uniqDocs
                 .map(
                   (d) =>
                     `<li><a class="td-handoff-doc-link" href="${escapeHtml(d.url)}" target="_blank" rel="noopener">${escapeHtml(d.label)} <span aria-hidden="true">↗</span></a></li>`,
                 )
                 .join('')}</ul>`
            : ''
        }
      </div>`
  }).join('<hr class="td-handoff-divider" />')

  return `
    <div class="task-decision-copy">
      <strong>转交审核</strong>
      <p class="td-handoff-route">${escapeHtml(route)}</p>
      ${reviewLocked ? '<p class="td-handoff-locked-hint">任务已结束，无法继续审核。</p>' : '<p>上一步已完成。同意后下一岗开始；驳回则不派下游。</p>'}
    </div>
    ${blocks}`
}

function renderTaskHero(page, state) {
  const task = state.task
  const titleEl = page.querySelector('#task-title')
  const metaEl = page.querySelector('#task-meta-line')
  const bannerEl = page.querySelector('#task-status-banner')
  if (!task) {
    if (titleEl) titleEl.textContent = '加载中...'
    if (metaEl) {
      metaEl.hidden = true
      metaEl.textContent = ''
    }
    if (bannerEl) {
      bannerEl.hidden = true
      bannerEl.innerHTML = ''
    }
    return
  }

  const fullName = taskDetailDisplayName(task)
  const shortName = cleanTaskHeroTitle(fullName)
  if (titleEl) {
    titleEl.textContent = shortName
    titleEl.title = fullName !== shortName ? fullName : ''
  }

  const group = toTaskStatusGroup(task.status)
  const statusKey = normalizeTaskStatusKey(task.status)
  const roster = Object.values(state.rolesByCode || {})
  const fromRole = resolveDetailRoleLabel(task, state)
  const handlers = normalizeTaskHandlers(taskHandlersOf(task))
  const toNames = handlers.map((h) => handlerDisplayName(h, roster)).filter(Boolean)
  const riskKey = String(task.risk_level || '').trim().toLowerCase()
  const riskZh = DETAIL_RISK_LABEL[riskKey] || ''
  const metaParts = []
  const handoffPending = Boolean(task.handlers_pending_approval) && statusKey !== 'reviewed'
  if (handoffPending) metaParts.push('转交审核')
  if (fromRole && toNames.length) metaParts.push(`${fromRole} → ${toNames.join('、')}`)
  else if (fromRole) metaParts.push(fromRole)
  if (riskZh) metaParts.push(riskZh)
  if (metaEl) {
    if (metaParts.length) {
      metaEl.hidden = false
      metaEl.textContent = metaParts.join(' · ')
    } else {
      metaEl.hidden = true
      metaEl.textContent = ''
    }
  }

  if (bannerEl) {
    if (group === 'cancelled') {
      const when = formatDetailClock(
        task.cancelled_at || task.cancelledAt || task.completed_at || task.completedAt || task.updated_at || task.updatedAt,
      )
      const reason = String(task.cancel_reason || task.cancelReason || task.status_comment || '用户取消').trim()
      bannerEl.hidden = false
      bannerEl.className = 'td-status-banner td-status-banner--cancelled'
      bannerEl.innerHTML = `<span class="td-status-banner__label">任务已取消</span><span class="td-status-banner__sep">·</span><span>${escapeHtml(reason)}</span>${when ? `<span class="td-status-banner__sep">·</span><time>${escapeHtml(when)}</time>` : ''}`
    } else if (group === 'failed') {
      const when = formatDetailClock(task.completed_at || task.updated_at || task.updatedAt)
      const err = String(task.error || '执行失败').trim().slice(0, 120)
      bannerEl.hidden = false
      bannerEl.className = 'td-status-banner td-status-banner--failed'
      bannerEl.innerHTML = `<span class="td-status-banner__label">执行失败</span><span class="td-status-banner__sep">·</span><span>${escapeHtml(err)}</span>${when ? `<span class="td-status-banner__sep">·</span><time>${escapeHtml(when)}</time>` : ''}`
    } else {
      bannerEl.hidden = true
      bannerEl.innerHTML = ''
      bannerEl.className = 'td-status-banner'
    }
  }
}

/** 待确认验收 / 开工前审批 — 决策区（完成态删除收进更多菜单） */
function renderTaskDecisionPanel(page, state) {
  const el = page.querySelector('#task-decision-panel')
  if (!el) return
  const task = state.task
  if (!task) {
    el.hidden = true
    el.innerHTML = ''
    return
  }
  const group = toTaskStatusGroup(task.status)
  const statusKey = normalizeTaskStatusKey(task.status)
  const waitingConfirm = new Set(['req_confirm', 'waiting_user', 'awaiting_close', 'waiting_confirmation', 'reviewed'])
  const reviewLocked = group === 'cancelled' || group === 'failed'

  // 转交审核：handlers 待批（批准后下一岗开始）
  if (task.handlers_pending_approval && statusKey !== 'reviewed') {
    el.hidden = false
    el.className = `task-decision-panel${reviewLocked ? ' task-decision-panel--locked' : ''}`
    const actionsHtml = reviewLocked
      ? ''
      : `<div class="task-decision-actions">
          <button type="button" class="btn btn-primary" data-gate-act="approve">同意派发</button>
          <button type="button" class="btn btn-danger-outline" data-gate-act="reject">驳回</button>
        </div>
        <div class="task-decision-note" data-gate-reject hidden>
          <label class="task-decision-note-label">驳回原因（必填）</label>
          <textarea class="form-input task-decision-note-input" rows="2" placeholder="简单说明原因，员工下一轮会看到"></textarea>
          <div class="task-decision-note-actions">
            <button type="button" class="btn btn-sm btn-danger" data-gate-act="reject-confirm">确认驳回</button>
            <button type="button" class="btn btn-sm btn-ghost" data-gate-act="reject-cancel">取消</button>
          </div>
        </div>`
    el.innerHTML = `
      ${renderHandoffReviewBodyHtml(task, state, { reviewLocked })}
      ${actionsHtml}`
    if (!reviewLocked) bindTaskGateActions(page, state)
    return
  }

  // 待确认：执行已结束，确认完成 / 要求修改（不再暂停）
  if (waitingConfirm.has(statusKey)) {
    const handlers = taskHandlersOf(task)
    const roster = Object.values(state.rolesByCode || {})
    el.hidden = false
    el.className = 'task-decision-panel'
    el.innerHTML = `
      <div class="task-decision-copy">
        <strong>执行已完成，等待确认</strong>
        <p>员工侧运行已结束。确认完成后任务结案；要求修改将打回继续执行。</p>
      </div>
      ${handlers.length ? renderHandlersReadonlyHtml(handlers, escapeHtml, { open: true, roles: roster }) : ''}
      <div class="task-decision-actions">
        <button type="button" class="btn btn-primary" data-review-act="complete">确认完成</button>
        <button type="button" class="btn btn-secondary" data-review-act="rework">要求修改</button>
      </div>
      <div class="task-decision-note" data-review-note hidden>
        <label class="task-decision-note-label">修改说明（必填）</label>
        <textarea class="form-input task-decision-note-input" rows="2" placeholder="说明需要改什么，员工下一轮会看到"></textarea>
        <div class="task-decision-note-actions">
          <button type="button" class="btn btn-sm btn-primary" data-review-act="confirm-note">确认打回</button>
          <button type="button" class="btn btn-sm btn-ghost" data-review-act="cancel-note">取消</button>
        </div>
      </div>`
    bindTaskReviewActions(page, state)
    return
  }

  if (group === 'failed') {
    const isChat = normalizeTaskSource(task.source) === 'chat'
    el.hidden = false
    el.className = 'task-decision-panel task-decision-panel--fail'
    el.innerHTML = `
      <div class="task-decision-copy">
        <strong>执行失败</strong>
        <p>可查看失败原因后重试；删除请用右上角「更多」。</p>
      </div>
      <div class="task-decision-actions">
        <button type="button" class="btn btn-primary" data-review-act="restart">再跑一次</button>
        ${isChat ? '<button type="button" class="btn btn-secondary" id="btn-view-workflow-fail">查看工作流</button>' : ''}
      </div>`
    el.querySelector('[data-review-act="restart"]')?.addEventListener('click', () => {
      void handleRestartTask(page, state)
    })
    el.querySelector('#btn-view-workflow-fail')?.addEventListener('click', () => {
      window.location.hash = `#/workflow/${state.taskId}`
    })
    return
  }

  const handlers = taskHandlersOf(task)
  if (handlers.length && (group === 'completed' || group === 'failed' || group === 'cancelled')) {
    el.hidden = false
    el.className = 'task-decision-panel task-decision-panel--handlers-ro'
    el.innerHTML = renderHandlersReadonlyHtml(handlers, escapeHtml, {
      roles: Object.values(state.rolesByCode || {}),
    })
    return
  }

  el.hidden = true
  el.innerHTML = ''
}

function bindTaskGateActions(page, state) {
  const el = page.querySelector('#task-decision-panel')
  if (!el || el._gateBound) return
  el._gateBound = true

  const rejectBox = () => el.querySelector('[data-gate-reject]')
  const noteInput = () => el.querySelector('.task-decision-note-input')

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-gate-act]')
    if (!btn) return
    const act = btn.dataset.gateAct
    const tid = String(state.taskId || '').trim()
    if (!tid) return

    if (act === 'approve') {
      btn.disabled = true
      try {
        await api.proactiveApprove(tid, 'approved', 'user', '')
        toast('已同意派发', 'success')
        await loadTaskDetail(page, state)
      } catch (err) {
        toast('审批失败：' + err, 'error')
        btn.disabled = false
      }
      return
    }
    if (act === 'reject') {
      const box = rejectBox()
      if (box) box.hidden = false
      noteInput()?.focus()
      return
    }
    if (act === 'reject-cancel') {
      const box = rejectBox()
      if (box) box.hidden = true
      const ta = noteInput()
      if (ta) ta.value = ''
      return
    }
    if (act === 'reject-confirm') {
      const reason = String(noteInput()?.value || '').trim()
      if (!reason) {
        toast('请填写驳回原因', 'warning')
        noteInput()?.focus()
        return
      }
      btn.disabled = true
      try {
        await api.proactiveApprove(tid, 'rejected', 'user', reason, reason)
        toast('已驳回', 'info')
        await loadTaskDetail(page, state)
      } catch (err) {
        toast('操作失败：' + err, 'error')
        btn.disabled = false
      }
    }
  })
}

function bindTaskReviewActions(page, state) {
  const el = page.querySelector('#task-decision-panel')
  if (!el || el._reviewBound) return
  el._reviewBound = true
  let pendingAct = null

  const noteBox = () => el.querySelector('[data-review-note]')
  const noteInput = () => el.querySelector('.task-decision-note-input')

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-review-act]')
    if (!btn) return
    const act = btn.dataset.reviewAct

    if (act === 'complete') {
      const handlersEditor = el.querySelector('[data-handlers-editor]')
      const handlers = handlersEditor ? collectHandlersFromEditor(handlersEditor) : []
      const yes = await showConfirm(
        handlers.length
          ? `确认验收通过？将派给 ${handlers.length} 位处理人开始跟进。`
          : '确认该任务已验收通过并标记为「已完成」？（未指定处理人，仅结案）',
      )
      if (!yes) return
      await applyTaskState(page, state, 'completed', '', { handlers })
      return
    }
    if (act === 'delete') {
      await handleDeleteTaskFromDetail(page, state)
      return
    }
    if (act === 'rework' || act === 'fail' || act === 'cancel-task') {
      pendingAct = act
      const box = noteBox()
      if (box) box.hidden = false
      noteInput()?.focus()
      return
    }
    if (act === 'cancel-note') {
      pendingAct = null
      const box = noteBox()
      if (box) box.hidden = true
      const ta = noteInput()
      if (ta) ta.value = ''
      return
    }
    if (act === 'confirm-note') {
      const comment = String(noteInput()?.value || '').trim()
      if ((pendingAct === 'rework' || pendingAct === 'fail') && !comment) {
        toast('请填写说明', 'warning')
        noteInput()?.focus()
        return
      }
      const status =
        pendingAct === 'fail' ? 'failed'
          : pendingAct === 'cancel-task' ? 'cancelled'
            : 'executing'
      await applyTaskState(page, state, status, comment)
      pendingAct = null
    }
  })
}

async function applyTaskState(page, state, status, comment = '', extras = {}) {
  try {
    await api.setTaskState(state.taskId, status, comment, '', extras)
    const labels = {
      completed: '已确认完成',
      executing: '已打回重做',
      failed: '已标记失败',
      cancelled: '已取消任务',
    }
    const n = Array.isArray(extras.handlers) ? extras.handlers.length : 0
    toast(
      status === 'completed' && n
        ? `已确认完成，已派给 ${n} 位处理人`
        : labels[status] || '状态已更新',
      status === 'failed' || status === 'cancelled' ? 'warning' : 'success',
    )
    await loadTaskDetail(page, state)
  } catch (e) {
    toast('操作失败：' + e, 'error')
  }
}

async function handleDeleteTaskFromDetail(page, state) {
  const yes = await showConfirm('确定删除此任务及其子任务？删除后不可恢复。')
  if (!yes) return
  try {
    await api.deleteTask(state.taskId)
    toast('任务已删除', 'success')
    window.location.hash = '#/tasks'
  } catch (e) {
    toast('删除失败：' + e, 'error')
  }
}

function applyDetailTab(page, state) {
  let tab = state.detailTab || 'overview'
  // 旧 Tab 兼容：步骤→日志；产出/变更/配置并回概览
  if (tab === 'steps') tab = 'logs'
  if (tab === 'outputs' || tab === 'changelog' || tab === 'config') tab = 'overview'
  if (!['overview', 'logs'].includes(tab)) tab = 'overview'
  // 员工任务不切到日志页，一律弹窗看执行过程
  if (tab === 'logs' && canOpenTaskWorkProcessPopup(state.task)) {
    tab = 'overview'
    state.detailTab = 'overview'
    // 仅在用户主动点 Tab 时弹窗；避免轮询/刷新反复打开
  }
  state.detailTab = tab
  page.dataset.tdTab = tab
  page.classList.toggle('td-tab--logs', tab === 'logs')
  page.classList.toggle('td-tab--overview', tab === 'overview')
  page.classList.remove('td-tab--config')
  page.querySelectorAll('#td-section-tabs [data-td-tab]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tdTab === tab)
  })
  page.querySelectorAll('[data-td-panel]').forEach((el) => {
    const panels = String(el.dataset.tdPanel || '').split(/\s+/).filter(Boolean)
    el.classList.toggle('td-tab-hidden', !panels.includes(tab))
  })
}

function renderExecTimeline(page, state) {
  const el = page.querySelector('#task-exec-timeline')
  if (!el) return
  const task = state.task
  const subtasks = Array.isArray(state.subtasks) ? state.subtasks : []
  const u = toUnifiedTaskStatus(task?.status)
  const show = u === 'running' || u === 'planning' || u === 'queued' || normalizeTaskStatusKey(task?.status) === 'paused'
  if (!task || !show) {
    el.hidden = true
    el.innerHTML = ''
    return
  }
  el.hidden = false
  const updated = formatDetailClock(task.updated_at || task.updatedAt) || '—'
  const duration = formatRunningDuration(task) || '—'
  const items = subtasks.length
    ? subtasks.map((s) => {
      const su = toUnifiedTaskStatus(s?.status)
      let phase = 'waiting'
      if (su === 'completed') phase = 'done'
      else if (su === 'running' || su === 'planning') phase = 'current'
      else if (su === 'failed') phase = 'failed'
      else if (su === 'cancelled') phase = 'cancelled'
      const label = {
        done: '已完成',
        current: '当前执行',
        waiting: '等待',
        failed: '异常',
        cancelled: '已取消',
      }[phase]
      const name = String(s?.name || s?.id || '步骤').trim()
      const step = phase === 'current' ? taskLiveStepText(s) : ''
      return `<li class="td-timeline-item td-timeline-item--${phase}">
        <span class="td-timeline-dot" aria-hidden="true"></span>
        <div class="td-timeline-body">
          <strong>${escapeHtml(name)}</strong>
          <span>${escapeHtml(step || `${label} · ${formatUnifiedStatusZh(s?.status)}`)}</span>
        </div>
      </li>`
    }).join('')
    : `<li class="td-timeline-item td-timeline-item--${u === 'planning' ? 'current' : 'waiting'}">
        <span class="td-timeline-dot" aria-hidden="true"></span>
        <div class="td-timeline-body">
          <strong>${u === 'planning' ? '正在规划' : (u === 'queued' ? '规划已完成，等待执行' : '等待步骤拆解')}</strong>
          <span>${escapeHtml(formatUnifiedStatusZh(task.status))}</span>
        </div>
      </li>`

  el.innerHTML = `
    <header class="td-timeline-head">
      <h2 class="td-card-title">执行步骤</h2>
      <div class="td-timeline-meta">
        <span>最近更新 ${escapeHtml(updated)}</span>
        <span>已运行 ${escapeHtml(duration)}</span>
      </div>
    </header>
    <ol class="td-timeline-list">${items}</ol>
    <div class="td-timeline-actions">
      ${isTaskPausableStatus(task.status) || normalizeTaskStatusKey(task.status) === 'paused'
        ? `<button type="button" class="btn btn-sm btn-warning" data-timeline-act="pause">${normalizeTaskStatusKey(task.status) === 'paused' ? '继续' : '暂停'}</button>`
        : ''}
      ${isTaskCancellableStatus(task.status)
        ? '<button type="button" class="btn btn-sm btn-secondary" data-timeline-act="cancel">取消</button>'
        : ''}
    </div>`

  if (!el._timelineBound) {
    el._timelineBound = true
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-timeline-act]')
      if (!btn) return
      if (btn.dataset.timelineAct === 'pause') void handlePauseButton(page, state)
      if (btn.dataset.timelineAct === 'cancel') void handleCancelTaskFromDetail(page, state)
    })
  }
}

function renderTaskChangelog(page, state) {
  const panel = page.querySelector('#task-changelog-panel')
  const body = page.querySelector('#task-changelog-body')
  if (!panel || !body) return
  const task = state.task
  if (!task) {
    body.innerHTML = '<p class="td-muted">暂无变更记录</p>'
    return
  }
  const entries = []
  const push = (time, text) => {
    if (!text) return
    entries.push({ time: time || '', text })
  }
  push(formatDetailClock(task.created_at || task.createdAt), '创建任务')
  if (task.started_at || task.startedAt) push(formatDetailClock(task.started_at || task.startedAt), '开始执行')
  if (toUnifiedTaskStatus(task.status) === 'cancelled') {
    push(
      formatDetailClock(task.cancelled_at || task.cancelledAt || task.completed_at || task.completedAt),
      `取消：${String(task.cancel_reason || task.cancelReason || '用户取消').trim()}`,
    )
  }
  if (toUnifiedTaskStatus(task.status) === 'completed') {
    push(formatDetailClock(task.completed_at || task.completedAt), '任务完成')
  }
  if (toUnifiedTaskStatus(task.status) === 'failed') {
    push(formatDetailClock(task.completed_at || task.completedAt || task.updated_at), `异常：${String(task.error || '执行失败').trim().slice(0, 80)}`)
  }
  const history = Array.isArray(task.status_history) ? task.status_history
    : (Array.isArray(task.change_log) ? task.change_log : [])
  for (const h of history) {
    const t = formatDetailClock(h?.at || h?.time || h?.created_at)
    const text = String(h?.message || h?.comment || h?.status || '').trim()
    if (text) push(t, text)
  }
  if (!entries.length) {
    body.innerHTML = '<p class="td-muted">暂无变更记录</p>'
    panel.hidden = state.detailTab !== 'changelog'
    return
  }
  body.innerHTML = `<ul class="td-changelog-list">${entries.map((e) => `
    <li>
      <time>${escapeHtml(e.time || '—')}</time>
      <span>${escapeHtml(e.text)}</span>
    </li>`).join('')}</ul>`
  panel.hidden = state.detailTab !== 'changelog'
}

async function handleCancelTaskFromDetail(page, state) {
  if (!isTaskCancellableStatus(state.task?.status)) {
    toast('当前状态不可取消', 'warning')
    return
  }
  const yes = await showConfirm('确定取消该任务？\n\n取消后任务将停止执行，记录仍保留。')
  if (!yes) return
  try {
    if (typeof api.cancelTask === 'function') await api.cancelTask(state.taskId)
    else await api.setTaskState(state.taskId, 'cancelled', '用户在任务详情取消')
    toast('已取消', 'success')
    await loadTaskDetail(page, state)
  } catch (e) {
    toast('取消失败：' + e, 'error')
  }
}

async function handleEditTaskFromDetail(page, state) {
  const task = state.task
  if (!task) return
  const u = toUnifiedTaskStatus(task.status)
  const fullEdit = u === 'pending'
  const replan = u === 'planning'
  const nameNoteOnly = !fullEdit
  showModal({
    title: replan ? '编辑并重新规划' : (nameNoteOnly ? '编辑名称/备注' : '编辑任务'),
    fields: [
      {
        name: 'name',
        label: u === 'completed' ? '标题' : '任务名称',
        value: String(task.name || ''),
        placeholder: '任务名称',
      },
      {
        name: 'description',
        label: nameNoteOnly && !replan ? '备注' : '任务描述',
        type: 'textarea',
        value: String(task.description || ''),
        placeholder: nameNoteOnly && !replan ? '补充备注' : '任务目标、约束与期望产物',
        rows: 4,
      },
    ],
    onConfirm: async (result) => {
      const name = String(result.name || '').trim()
      if (!name) {
        toast('请输入任务名称', 'error')
        return
      }
      try {
        await api.updateTask(state.taskId, {
          name,
          description: String(result.description || '').trim(),
        })
        if (replan) {
          try {
            await api.startTaskPlanning(state.taskId)
            toast('已保存并重新规划', 'success')
          } catch (e) {
            toast('已保存，但重新规划失败：' + e, 'warning')
          }
        } else {
          toast('已保存', 'success')
        }
        await loadTaskDetail(page, state)
      } catch (e) {
        toast('保存失败：' + e, 'error')
      }
    },
  })
}

async function handleCopyRecreateFromDetail(page, state) {
  const task = state.task
  if (!task) return
  const baseName = String(task.name || '未命名任务').trim()
  const name = baseName.endsWith('（副本）') ? baseName : `${baseName}（副本）`
  const desc = String(task.description || task.goal || '').trim()
  const runMode = String(task.run_mode || task.runMode || 'manual') === 'unattended' ? 'unattended' : 'manual'
  showModal({
    title: '复制并重新创建',
    fields: [
      { name: 'name', label: '任务名称', value: name, placeholder: '任务名称' },
      { name: 'description', label: '任务描述', type: 'textarea', value: desc, rows: 4 },
    ],
    onConfirm: async (result) => {
      const nextName = String(result.name || '').trim()
      if (!nextName) {
        toast('请输入任务名称', 'error')
        return
      }
      try {
        const created = await api.createTask(nextName, String(result.description || '').trim(), runMode)
        const newId = String(created?.id || created?.data?.id || created?.task_id || '').trim()
        toast('已创建新任务', 'success')
        if (newId) window.location.hash = `#/task/${encodeURIComponent(newId)}`
        else window.location.hash = '#/tasks'
      } catch (e) {
        toast('创建失败：' + e, 'error')
      }
    },
  })
}

async function handleRestartTask(page, state) {
  const yes = await showConfirm('将基于当前任务再跑一版（原任务会归档）。确定继续？')
  if (!yes) return
  try {
    toast('正在创建新任务…', 'info')
    const result = await api.restartTask(state.taskId)
    const newTaskId = result?.new_task_id || result?.data?.new_task_id
    if (!newTaskId) throw new Error(result?.message || '创建新任务失败')
    toast(`新任务已创建: ${newTaskId}`, 'success')
    const newThreadId = result.new_thread_id || result?.data?.new_thread_id || ''
    const newSessionKey = result.new_session_key || result?.data?.new_session_key || `agent:main:task-${newTaskId}`
    sessionStorage.setItem('evopanel_pending_shell_session', newSessionKey)
    sessionStorage.setItem('evopanel_pending_shell_thread', newThreadId)
    sessionStorage.setItem('evopanel_pending_shell_task_id', newTaskId)
    sessionStorage.removeItem('evopanel_pending_shell_processed')
    window.location.hash = '#/chat'
  } catch (e) {
    toast('再跑一次失败：' + e, 'error')
  }
}

function syncConversationPanelUi(page, state) {
  const section = page.querySelector('#task-conversation-section')
  const content = page.querySelector('#conversation-content')
  const toggle = page.querySelector('#btn-toggle-conversation')
  const hint = page.querySelector('[data-role="conv-toggle-hint"]')
  const refresh = page.querySelector('#btn-refresh-output')
  const expanded = !!state.conversationExpanded
  section?.classList.toggle('is-conversation-collapsed', !expanded)
  if (content) content.hidden = !expanded
  if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false')
  if (hint) hint.textContent = expanded ? '收起' : '展开'
  if (refresh) refresh.hidden = !expanded
}

function unescapeTaskText(raw) {
  return String(raw || '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .trim()
}

function renderTaskDescription(page, task) {
  const el = page.querySelector('#task-brief-panel')
  if (!el) return
  if (!task) {
    el.hidden = true
    el.innerHTML = ''
    return
  }
  const rationale = unescapeTaskText(task.rationale || '')
  const desc = unescapeTaskText(taskDescriptionForDisplay(task) || task.description || '')
  const goal = unescapeTaskText(task.plan_goal || task.goal || '')
  const expected = unescapeTaskText(task.expected_outcome || '')

  // Prefer employee note (rationale) as lead; fall back to description / goal
  const body = rationale || desc || goal
  if (!body && !expected) {
    el.hidden = true
    el.innerHTML = ''
    return
  }

  // 审批说明与原始需求高度重叠时，只展示一份，避免主栏叠两块同质内容
  const showExtraDesc =
    Boolean(rationale) &&
    Boolean(desc) &&
    desc !== rationale &&
    !textLooksSimilar(rationale, desc)

  el.hidden = false
  el.innerHTML = `
    <h2 class="td-card-title">简要说明</h2>
    <div class="td-brief-body md-body">${body ? renderMarkdown(body) : '<p>（暂无说明）</p>'}</div>
    ${
      showExtraDesc
        ? `<div class="td-brief-extra"><div class="td-aside-k">原始需求</div><div class="td-brief-body md-body">${renderMarkdown(desc)}</div></div>`
        : ''
    }
    ${
      expected && expected !== body
        ? `<div class="td-brief-extra"><div class="td-aside-k">预期结果</div><div class="td-brief-body md-body"><p>${escapeHtml(expected)}</p></div></div>`
        : ''
    }
  `
}

/** Rough overlap check for rationale vs description (avoid duplicate blocks). */
function textLooksSimilar(a, b) {
  const norm = (s) =>
    String(s || '')
      .replace(/\s+/g, '')
      .replace(/[\\n\\r\\t]/g, '')
      .slice(0, 180)
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  if (x.includes(y.slice(0, Math.min(48, y.length))) || y.includes(x.slice(0, Math.min(48, x.length)))) {
    return true
  }
  // Shared distinctive tokens (file path / title phrase)
  const hits = ['organic-handoff', '有机转交', 'HandoffRequest', 'approval']
  const shared = hits.filter((t) => x.includes(t) && y.includes(t)).length
  return shared >= 2
}

async function loadTaskDetail(page, state) {
  try {
    state.task = await api.getTask(state.taskId)
    state.projectId = state.taskId
    state.subtasks = state.task.subtasks || []

    await ensureTaskDetailMaps(state)
    renderTaskHero(page, state)
    renderTaskDescription(page, state.task)
    updateTaskStatusTag(page, state.task.status)
    syncTaskHeroProgress(page, state)
    updateButtons(page, state)
    updateChatOnlyHeroActions(page, state.task)
    updateAppProvenanceUi(page, state.task)
    renderTaskObsSubtasks(page, state)
    renderTaskOutcomePanel(page, state)
    renderTaskDecisionPanel(page, state)

    // 加载执行历史；主控对话仅内嵌调试展开时加载
    await loadExecutionHistory(page, state)
    if (shouldLoadConversation(state)) {
      await loadTaskConversation(page, state)
    }

    // 根据任务状态管理轮询
    setupOutputPolling(page, state)

    try {
      const runtime = await api.getTaskRuntime(state.taskId)
      state.agents = runtime.agents || []
    } catch {
      state.agents = []
    }

    await loadTaskObservability(page, state)

    logTaskDetail('loadTaskDetail', {
      taskId: state.taskId,
      taskStatus: state.task?.status,
      subtaskCount: Array.isArray(state.subtasks) ? state.subtasks.length : 0,
      subtasks: (state.subtasks || []).map((s) => ({
        id: s?.id,
        status: s?.status,
        progress: s?.progress,
        hasResult: !!String(s?.result || '').trim(),
        resultLen: String(s?.result || '').length,
        hasError: !!String(s?.error || '').trim(),
      })),
    })
  } catch (e) {
    toast('加载任务详情失败: ' + e, 'error')
    logTaskDetail('loadTaskDetail:error', { taskId: state.taskId, error: String(e) })
    const titleEl = page.querySelector('#task-title')
    if (titleEl) titleEl.textContent = '加载失败'
    const descEl = page.querySelector('#task-desc')
    if (descEl) descEl.textContent = String(e?.message || e)
  }
}

function taskDetailNeedsStatusPoll(status) {
  const u = toUnifiedTaskStatus(status)
  if (u === 'completed' || u === 'failed' || u === 'cancelled') return false
  // pending / planning / queued / running / waiting_confirmation / paused
  return true
}

function taskDetailPollIntervalMs(status) {
  const key = normalizeTaskStatusKey(status)
  if (isTaskRunningStatus(key) || isTaskPlanningStatus(key)) return 2000
  if (isTaskQueuedStatus(key) || key === 'paused' || isTaskWaitingConfirmation(key)) return 3000
  return 4000
}

function setupOutputPolling(page, state) {
  // 清除现有轮询
  if (state.outputRefreshInterval) {
    clearInterval(state.outputRefreshInterval)
    state.outputRefreshInterval = null
  }

  const statusKey = normalizeTaskStatusKey(state.task?.status)
  if (!taskDetailNeedsStatusPoll(statusKey)) return

  const pollMs = taskDetailPollIntervalMs(statusKey)
  state.outputRefreshInterval = setInterval(async () => {
    if (state._heroPollInFlight) return
    state._heroPollInFlight = true
    try {
      const prevStatus = normalizeTaskStatusKey(state.task?.status)
      const t = await api.getTask(state.taskId)
      state.task = t
      state.subtasks = t.subtasks || []
      renderTaskHero(page, state)
      renderTaskDescription(page, t)
      updateTaskStatusTag(page, t.status)
      syncTaskHeroProgress(page, state)
      updateButtons(page, state)
      updateChatOnlyHeroActions(page, t)
      updateAppProvenanceUi(page, t)
      renderTaskObsSubtasks(page, state)
      renderTaskOutcomePanel(page, state)
      renderTaskDecisionPanel(page, state)
      if (shouldLoadConversation(state)) {
        await loadTaskConversation(page, state)
      }
      await loadTaskObservability(page, state)
      const nextStatus = normalizeTaskStatusKey(t.status)
      // Re-arm when status class changes (queued→running, running→done, interval change).
      if (
        prevStatus !== nextStatus ||
        taskDetailPollIntervalMs(prevStatus) !== taskDetailPollIntervalMs(nextStatus) ||
        !taskDetailNeedsStatusPoll(nextStatus)
      ) {
        setupOutputPolling(page, state)
      }
    } catch (e) {
      logTaskDetail('heroPoll:error', { taskId: state.taskId, error: String(e) })
    } finally {
      state._heroPollInFlight = false
    }
  }, pollMs)
}

async function loadTaskConversation(page, state) {
  try {
    // 从 Gateway 应用层 transcript 获取对话记录
    const task = state.task || await api.getTask(state.taskId)
    const threadId = task?.thread_id || state.currentThreadId
    
    if (!threadId) {
      state.conversationMessages = []
      renderTaskConversation(page, state)
      return
    }
    
    // 应用层 transcript（evoflow_chat_messages），与 LangGraph checkpoint 解耦
    const payload = await api.chatMessagesByThread(threadId, 150)
    const rawMessages = Array.isArray(payload?.messages) ? payload.messages : []
    
    // 转换为统一的消息格式
    state.conversationMessages = rawMessages.map(msg => {
      // 处理 content 可能是数组的情况
      let content = msg.content || ''
      if (Array.isArray(content)) {
        content = content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('')
      }
      
      // 规范化角色
      let role = msg.role || (msg.type === 'human' ? 'user' : msg.type === 'ai' ? 'assistant' : 'unknown')
      
      return {
        role: role,
        content: content,
        timestamp: msg.timestamp,
        type: msg.type,
        name: msg.name,
      }
    })
    
    renderTaskConversation(page, state)
    logTaskDetail('loadTaskConversation', {
      taskId: state.taskId,
      threadId,
      rawCount: Array.isArray(rawMessages) ? rawMessages.length : 0,
      displayCount: Array.isArray(state.conversationMessages) ? state.conversationMessages.length : 0,
    })
  } catch (e) {
    console.error('[loadTaskConversation] Error:', e)
    state.conversationMessages = []
    renderTaskConversation(page, state)
    logTaskDetail('loadTaskConversation:error', { taskId: state.taskId, error: String(e) })
  }
}

function renderTaskConversation(page, state) {
  const container = page.querySelector('#conversation-content')
  if (!container) return

  const messages = state.conversationMessages || []
  
  if (!messages.length) {
    container.innerHTML = '<div class="output-empty">暂无对话记录<br><span style="font-size:11px;color:var(--text-tertiary)">主控 Agent 执行后将显示对话</span></div>'
    return
  }

  // 过滤消息（隐藏系统消息和工具消息）
  const displayMessages = messages.filter(msg => {
    if (!msg || typeof msg !== 'object') return false
    
    const role = msg.role || ''
    const type = msg.type || ''
    const name = msg.name || ''
    
    // 1. 过滤 tool 类型消息
    if (role === 'tool' || role === 'toolResult' || type === 'tool' || type === 'tool_message') {
      return false
    }
    
    // 2. 过滤系统消息（collab_phase_hint 等中间件注入）
    const injectedNames = ['todo_reminder', 'collab_phase_hint', 'conversation_summary', 'tool_history']
    if (name && injectedNames.includes(name)) return false

    let rawContent = msg.content || ''
    const rawText = typeof rawContent === 'string'
      ? rawContent.trimStart()
      : (Array.isArray(rawContent)
        ? rawContent.map((b) => (b?.type === 'text' ? b.text : '')).join('\n').trimStart()
        : '')
    if (
      rawText.startsWith('[CONTEXT COMPACTION') ||
      rawText.startsWith('[上下文摘要') ||
      rawText.startsWith('[深度压缩摘要') ||
      rawText.startsWith('[tool:history]') ||
      rawText.toLowerCase().startsWith('here is a summary of the conversation to date') ||
      rawText.toLowerCase().startsWith("here's a summary of the conversation to date")
    ) {
      return false
    }
    
    // 3. 过滤空内容的 AI 消息
    let hasRealContent = false
    
    if (Array.isArray(rawContent)) {
      for (const block of rawContent) {
        if (block.type === 'text' && block.text?.trim()) {
          hasRealContent = true
          break
        }
      }
    } else if (typeof rawContent === 'string' && rawContent.trim()) {
      hasRealContent = true
    }
    
    if ((role === 'assistant' || type === 'ai' || type === 'AIMessage') && !hasRealContent) {
      return false
    }
    
    if (!hasRealContent) return false
    
    return true
  })

  if (!displayMessages.length) {
    container.innerHTML = '<div class="output-empty">暂无对话记录<br><span style="font-size:11px;color:var(--text-tertiary)">主控 Agent 执行后将显示对话</span></div>'
    return
  }

  // 丰富好看的卡片式消息样式，支持 Markdown
  container.innerHTML = displayMessages.map(msg => {
    const role = msg.role || ''
    const type = msg.type || ''
    let content = msg.content || ''
    const timestamp = msg.timestamp
    
    // 处理 content 为数组的情况
    if (Array.isArray(content)) {
      const texts = []
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text)
        }
      }
      content = texts.join('')
    }
    
    // 格式化时间
    let timeStr = ''
    if (timestamp) {
      try {
        const date = new Date(timestamp)
        if (!isNaN(date.getTime())) {
          timeStr = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        }
      } catch {}
    }
    
    // 根据角色选择样式
    let roleLabel
    let roleClass
    
    // 规范化角色
    let normalizedRole = role
    const typeLower = String(type).toLowerCase()
    if (role === 'user' || typeLower === 'human' || typeLower === 'humanmessage' || type === 'user') {
      normalizedRole = 'user'
    } else if (role === 'assistant' || type === 'ai' || type === 'AIMessage' || type === 'AIMessageChunk') {
      normalizedRole = 'assistant'
    }
    
    switch (normalizedRole) {
      case 'user':
        roleLabel = '👤 用户'
        roleClass = 'user-message'
        break
      case 'assistant':
        roleLabel = '🧭 主控'
        roleClass = 'ai-message lead-message'
        break
      default:
        roleLabel = '🧭 主控'
        roleClass = 'ai-message lead-message'
    }
    
    // 渲染内容（Markdown）
    const contentHtml = content ? renderMarkdown(content) : ''
    
    return `
      <div class="conversation-message ${roleClass}">
        <div class="message-header">
          <span class="message-role">${roleLabel}</span>
          <span class="message-time">${timeStr}</span>
        </div>
        <div class="message-body">
          ${contentHtml}
        </div>
      </div>
    `
  }).join('')
  
  // 滚动到底部
  container.scrollTop = container.scrollHeight
}

async function loadExecutionHistory(page, state) {
  try {
    const response = await api.getExecutionHistory(state.taskId)

    state.executionHistory = response.execution_history || []
    state.currentThreadId = response.current_thread_id
    state.currentSessionKey = response.session_key

    // 更新下拉框
    const select = page.querySelector('#execution-history-select')
    if (select) {
      select.innerHTML = '<option value="current">当前执行</option>'

      state.executionHistory.forEach(record => {
        const option = document.createElement('option')
        option.value = record.execution_id
        const statusIcon = record.status === 'completed' ? '✅' :
                          record.status === 'failed' ? '❌' :
                          record.status === 'cancelled' ? '⏸️' : '⏳'
        const timeStr = record.started_at ? new Date(record.started_at).toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        }) : ''
        option.textContent = `${statusIcon} ${record.execution_id} - ${timeStr}`
        select.appendChild(option)
      })
    }
  } catch (e) {
    console.error('[task-detail] 加载执行历史失败:', e)
  }
}

function renderSubtasks(page, state) {
  const container = page.querySelector('#subtasks-list')

  if (!state.subtasks.length) {
    container.innerHTML = '<div class="subtasks-empty">暂无子任务<br><span style="font-size:11px;color:var(--text-tertiary)">AI 将自动拆解任务，或手动添加子任务</span></div>'
    return
  }

  container.innerHTML = state.subtasks.map(sub => {
    const statusIcon = getSubtaskStatusIcon(sub.status)
    const statusTagClass = getSubtaskStatusTagClass(sub.status)
    const statusText = getSubtaskStatusText(sub.status)
    const progressBar = sub.progress > 0 ? `<div class="task-progress-bar"><div class="task-progress-fill" style="width:${sub.progress}%"></div></div>` : ''
    const assignedName = resolveAssignedAgentDisplayName(sub.assigned_to, state.agents) || sub.assigned_to || '未分配'

    return `
      <div class="subtask-item" data-subtask-id="${sub.id}">
        <div class="subtask-status-icon">${statusIcon}</div>
        <div class="subtask-info">
          <div class="subtask-info-top">
            <code class="subtask-id-text">${escapeHtml(sub.name || '未命名')}</code>
            ${sub.dependencies?.length ? `<span class="tag tag--subtle">依赖 ${sub.dependencies.length}</span>` : ''}
            ${sub.worker_profile ? '<span class="tag tag--config">配置</span>' : ''}
          </div>
          <div class="subtask-meta">
            🤖 ${escapeHtml(assignedName)}
            ${sub.progress > 0 ? ` · ${sub.progress}%` : ''}
            ${sub.description ? ` · ${escapeHtml(sub.description.slice(0, 30))}${sub.description.length > 30 ? '...' : ''}` : ''}
          </div>
        </div>
        <span class="subtask-status-chip tag ${statusTagClass}" title="状态：${escapeHtml(statusText)}">${escapeHtml(statusText)}</span>
        <div class="subtask-actions">
          <button class="btn btn-xs btn-ghost" data-action="detail" data-id="${sub.id}" title="详情">📄</button>
          <button class="btn btn-xs btn-secondary" data-action="assign" data-id="${sub.id}" title="分配">🤖</button>
          <button class="btn btn-xs btn-danger" data-action="delete" data-id="${sub.id}" title="删除">✕</button>
        </div>
        <div class="subtask-progress-mini">${progressBar}</div>
      </div>
    `
  }).join('')
  logTaskDetail('renderSubtasks', {
    taskId: state.taskId,
    count: state.subtasks.length,
    subtasks: state.subtasks.map((s) => ({
      id: s?.id,
      name: s?.name,
      status: s?.status,
      hasResult: !!String(s?.result || '').trim(),
      resultPreview: String(s?.result || '').slice(0, 120),
      hasError: !!String(s?.error || '').trim(),
      claudeSessionId: s?.claude_session_id || s?.external_session_id || s?.claudeSessionId,
    })),
  })

  container.querySelectorAll('[data-action="detail"]').forEach(btn => {
    btn.addEventListener('click', () => showSubtaskDetail(page, state, btn.dataset.id))
  })

  container.querySelectorAll('[data-action="assign"]').forEach(btn => {
    btn.addEventListener('click', () => showAssignDialog(page, state, btn.dataset.id))
  })

  container.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => deleteSubtask(page, state, btn.dataset.id))
  })

  container.querySelectorAll('[data-action="view-result"]').forEach(btn => {
    btn.addEventListener('click', () => viewSubtaskResult(page, state, btn.dataset.id))
  })
}

/* 任务记忆面板已隐藏
function renderFacts(page, facts) {
  const container = page.querySelector('#facts-list')

  if (!facts.length) {
    container.innerHTML = '<div class="facts-empty">暂无记忆<br><span style="font-size:11px;color:var(--text-tertiary)">任务执行后会自动提取关键事实</span></div>'
    return
  }

  const categoryLabels = { finding: '发现', decision: '决策', data: '数据', conclusion: '结论' }
  const categoryColors = { finding: '#3b82f6', decision: '#f59e0b', data: '#10b981', conclusion: '#8b5cf6' }

  container.innerHTML = facts.map(fact => `
    <div class="fact-item">
      <div class="fact-header">
        <span class="fact-category" style="background:${categoryColors[fact.category] || '#6b7280'}">${categoryLabels[fact.category] || fact.category}</span>
        <span class="fact-confidence">${Math.round((fact.confidence || 0.5) * 100)}%</span>
      </div>
      <p class="fact-content">${escapeHtml(fact.content || '')}</p>
    </div>
  `).join('')
}
*/

/* 执行者状态面板已隐藏
function renderAgents(page, state) {
  const container = page.querySelector('#agents-list')

  if (!state.agents.length) {
    container.innerHTML = '<div class="agents-empty">暂无执行中的 Agent</div>'
    return
  }

  container.innerHTML = state.agents.map(agent => {
    const statusIcon = agent.status === 'busy' ? '🔴' : agent.status === 'failed' ? '⚫' : '🟢'
    return `
      <div class="agent-item">
        <div class="agent-info">
          <span class="agent-status-icon">${statusIcon}</span>
          <span class="agent-name">${escapeHtml(agent.agent_name || agent.agent_id)}</span>
        </div>
        ${agent.current_subtask_id ? `<div class="agent-task">子任务: ${agent.current_subtask_id}</div>` : ''}
        ${agent.progress > 0 ? `<div class="agent-progress">进度: ${agent.progress}%</div>` : ''}
      </div>
    `
  }).join('')
}
*/

function updateTaskStats(page, state) {
  const container = page.querySelector('#task-stats')
  const stats = {
    total: state.subtasks.length,
    pending: state.subtasks.filter(t => t.status === 'pending').length,
    executing: state.subtasks.filter(t => t.status === 'executing').length,
    completed: state.subtasks.filter(t => t.status === 'completed').length,
    failed: state.subtasks.filter(t => t.status === 'failed').length,
  }

  container.innerHTML = `
    <span class="stat-item">总计: ${stats.total}</span>
    <span class="stat-item stat-pending">待处理: ${stats.pending}</span>
    <span class="stat-item stat-executing">执行中: ${stats.executing}</span>
    <span class="stat-item stat-completed">完成: ${stats.completed}</span>
    ${stats.failed > 0 ? `<span class="stat-item stat-failed">失败: ${stats.failed}</span>` : ''}
  `
  syncTaskHeroProgress(page, state)
}

/** 顶栏进度：仅执行中显示百分比；规划中/待执行不显示伪 100% */
function syncTaskHeroProgress(page, state) {
  const t = state.task
  if (!t) return
  const meta = computeTaskExecutionProgress(t, state.subtasks)
  const u = meta.unified
  const wrap = page.querySelector('#task-progress-wrap')
  const active = u === 'running' || u === 'planning' || normalizeTaskStatusKey(t.status) === 'paused'
  if (wrap) wrap.hidden = !active
  if (active) {
    const fill = page.querySelector('#task-progress-fill')
    const valueEl = page.querySelector('#task-progress-value')
    const labelEl = page.querySelector('#task-progress-label')
    const setFill = (pct, buffering = false) => {
      if (!fill) return
      fill.style.width = `${pct}%`
      fill.classList.toggle('is-buffering', buffering)
    }
    if (u === 'planning') {
      setFill(0, false)
      if (valueEl) valueEl.textContent = ''
      if (labelEl) labelEl.textContent = '规划中'
    } else if (u === 'queued') {
      setFill(0, false)
      if (valueEl) valueEl.textContent = ''
      if (labelEl) labelEl.textContent = '规划已完成，等待执行'
    } else if (normalizeTaskStatusKey(t.status) === 'paused') {
      const pct = meta.showPercent && meta.progress != null ? meta.progress : 0
      setFill(pct, false)
      if (valueEl) valueEl.textContent = meta.showPercent ? `${pct}%` : '—'
      if (labelEl) labelEl.textContent = '已暂停'
    } else {
      const pct = meta.showPercent && meta.progress != null ? meta.progress : 0
      setFill(pct, pct < 100)
      if (valueEl) valueEl.textContent = meta.showPercent ? `${pct}%` : '—'
      if (labelEl) labelEl.textContent = '正在执行'
    }
    const subEl = page.querySelector('#task-progress-sub')
    if (subEl) {
      const activity = latestTaskActivityText(t, state.subtasks)
      if (activity) {
        subEl.hidden = false
        subEl.textContent = activity
      } else if (meta.subtaskCount > 0 && u === 'running') {
        subEl.hidden = false
        subEl.textContent = isWorkflowAppTask(t)
          ? nodeProgressLabel(meta.completedCount, meta.subtaskCount)
          : `子任务 ${meta.completedCount}/${meta.subtaskCount} 已完成`
      } else {
        subEl.hidden = true
        subEl.textContent = ''
      }
    }
  }
  renderTaskHero(page, state)
  renderTaskStatusLine(page, state)
  renderTaskInfoChips(page, state)
  renderExecTimeline(page, state)
  renderTaskChangelog(page, state)
  updateMoreMenu(page, state)
  updateButtons(page, state)
  applyDetailTab(page, state)
}

function taskProgressMeta(task, subtasks) {
  const meta = computeTaskExecutionProgress(task, subtasks)
  return {
    progress: meta.progress ?? 0,
    showPercent: meta.showPercent,
    subtaskCount: meta.subtaskCount,
    completedCount: meta.completedCount,
    unified: meta.unified,
    label: meta.label,
  }
}

async function ensureTaskDetailMaps(state) {
  if (state._mapsLoaded) return
  try {
    const [agents, rolesRes] = await Promise.all([
      api.listAgents().catch(() => []),
      api.proactiveListRoles().catch(() => null),
    ])
    state.agentCatalog = Array.isArray(agents) ? agents : []
    const roles = Array.isArray(rolesRes?.roles) ? rolesRes.roles : (Array.isArray(rolesRes) ? rolesRes : [])
    const map = {}
    for (const r of roles) {
      const code = String(r?.agent_code || '').trim().toLowerCase()
      if (code) map[code] = r
    }
    state.rolesByCode = map
  } catch {
    state.agentCatalog = state.agentCatalog || []
    state.rolesByCode = state.rolesByCode || {}
  }
  state._mapsLoaded = true
}

function resolveDetailRoleLabel(task, state) {
  const role = String(task?.assigned_role || '').trim()
  if (role) return role
  const code = String(task?.assigned_to || '').trim().toLowerCase()
  if (code) {
    const name = String(state?.rolesByCode?.[code]?.role_name || '').trim()
    if (name) return name
  }
  return ''
}

function resolveDetailAgentLabel(task, state) {
  const code = String(task?.assigned_to || '').trim()
  if (!code) return ''
  return resolveAssignedAgentDisplayName(code, state?.agentCatalog || state?.agents || []) || code
}

function taskLiveStepText(obj) {
  return String(obj?.current_step || obj?.currentStep || obj?.progress_summary || '').trim()
}

/** 顶栏/时间线用的一句话最新进度（子任务 current_step 优先） */
function latestTaskActivityText(task, subtasks) {
  const list = Array.isArray(subtasks) ? subtasks : []
  const running = list.filter((s) => {
    const u = toUnifiedTaskStatus(s?.status)
    return u === 'running' || u === 'planning'
  })
  for (const s of running) {
    const step = taskLiveStepText(s)
    if (!step) continue
    const name = String(s?.name || '').trim()
    return running.length === 1 || !name ? step : `${name}：${step}`
  }
  const fromTask = taskLiveStepText(task)
  if (fromTask) return fromTask
  if (running.length === 1) {
    const name = String(running[0]?.name || '').trim()
    return name ? `正在执行：${name}` : '正在执行'
  }
  if (running.length > 1) {
    const names = running.map((s) => String(s?.name || '').trim()).filter(Boolean).slice(0, 2)
    return names.length ? `并行推进：${names.join('、')}${running.length > 2 ? '…' : ''}` : '正在并行执行'
  }
  return ''
}

function formatDetailClock(raw) {
  if (!raw) return ''
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return String(raw)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function renderTaskInfoChips(page, state) {
  const el = page.querySelector('#task-info')
  if (!el) return
  const task = state.task
  if (!task) {
    el.innerHTML = ''
    return
  }
  const sourceKey = normalizeTaskSource(task.source)
  const sourceLabel = formatTaskSourceZh(task.source_zh || task.source)
  const channelRaw = String(task.source_channel || '').trim().toLowerCase()
  const channelZh = DETAIL_SOURCE_CHANNEL_ZH[channelRaw] || (channelRaw && channelRaw !== sourceKey ? channelRaw : '')
  const roleLabel = resolveDetailRoleLabel(task, state)
  const agentLabel = resolveDetailAgentLabel(task, state)
  const progressMeta = taskProgressMeta(task, state.subtasks)
  const { subtaskCount, completedCount } = progressMeta
  const appName = resolveSourceAppName(task) || resolveSourceAppId(task)
  const created = formatDetailClock(task.created_at || task.createdAt)
  const updated = formatDetailClock(task.updated_at || task.updatedAt)
  const started = formatDetailClock(task.started_at || task.startedAt)
  const finished = formatDetailClock(task.completed_at || task.completedAt)
  const desc = unescapeTaskText(taskDescriptionForDisplay(task) || '')
  const goal = unescapeTaskText(task.plan_goal || '') || desc
  const expected = unescapeTaskText(task.expected_outcome || '')
  const workflow = isWorkflowAppTask(task)
  const kindZh = runKindLabelZh(resolveTaskRunKind(task))
  const trigger = String(task.trigger_kind || task.triggerKind || 'manual').trim().toLowerCase()
  const triggerZh = trigger === 'api' ? 'API 触发'
    : (trigger === 'schedule' || trigger === 'scheduled' || trigger === 'cron') ? '定时触发'
      : '手动触发'
  const statusZh = formatUnifiedStatusZh(task.status)
  const riskKey = String(task.risk_level || '').trim().toLowerCase()
  const riskZh = DETAIL_RISK_LABEL[riskKey] || (riskKey || '')
  const actionKey = String(task.action_type || '').trim().toLowerCase()
  const actionZh = DETAIL_ACTION_TYPE_LABEL[actionKey] || (actionKey || '')
  const roster = Object.values(state.rolesByCode || {})
  const raisedRaw = String(task.raised_by || '').trim()
  const raisedZh = raisedRaw ? formatRaisedByLabel(raisedRaw, roster) : ''
  const wokenRaw = String(task.woken_by || '').trim()
  const wokenZh =
    wokenRaw && wokenRaw.toLowerCase() !== raisedRaw.toLowerCase()
      ? formatRaisedByLabel(wokenRaw, roster)
      : ''
  const parentId = String(task.parent_task_id || task.parent?.task_id || '').trim()
  const parentName = String(task.parent?.name || '').trim()
  const childIds = Array.isArray(task.child_task_ids) ? task.child_task_ids.filter(Boolean) : []
  const cancelledAt = formatDetailClock(task.cancelled_at || task.cancelledAt || (toUnifiedTaskStatus(task.status) === 'cancelled' ? (task.completed_at || task.completedAt) : ''))
  const cancelReason = String(task.cancel_reason || task.cancelReason || task.status_comment || '').trim()

  const primary = []
  const more = []
  primary.push(['状态', statusZh])
  if (progressMeta.unified === 'cancelled') {
    if (cancelledAt) primary.push(['取消时间', cancelledAt])
    primary.push(['取消原因', cancelReason || '用户取消'])
    more.push(['取消时进度', progressMeta.showPercent ? `${progressMeta.progress}%` : '—'])
  } else if (progressMeta.showPercent && progressMeta.progress != null) {
    primary.push(['执行进度', `${progressMeta.progress}%`])
  } else if (progressMeta.unified === 'queued') {
    primary.push(['阶段', '规划已完成，等待执行'])
  } else if (progressMeta.unified === 'planning') {
    primary.push(['阶段', '规划中'])
  }
  if (workflow) {
    primary.push(['任务类型', '工作流运行'])
    if (kindZh) more.push(['运行模式', kindZh])
    more.push(['触发方式', triggerZh])
    if (appName) more.push(['来源工作流', appName])
    if (subtaskCount > 0) primary.push(['节点进度', `${completedCount} / ${subtaskCount}`])
  } else {
    if (roleLabel) primary.push(['执行岗位', roleLabel])
    if (agentLabel && agentLabel !== roleLabel) primary.push(['智能体', agentLabel])
    if (raisedZh) primary.push(['提出人', raisedZh])
    if (riskZh) primary.push(['风险', riskZh])
    if (actionZh) more.push(['类型', actionZh])
    if (sourceLabel && sourceLabel !== '未标注') {
      more.push(['来源', channelZh ? `${sourceLabel} · ${channelZh}` : sourceLabel])
    } else if (channelZh) {
      more.push(['来源', channelZh])
    }
    if (wokenZh) more.push(['叫醒', wokenZh])
    if (subtaskCount > 0) more.push(['子任务', `${completedCount}/${subtaskCount}`])
  }
  if (started) primary.push(['开始时间', started])
  if (finished) more.push(['完成时间', finished])
  if (created) more.push(['创建时间', created])
  if (updated && updated !== finished && updated !== created) more.push(['更新时间', updated])

  const rowHtml = (rows) =>
    rows
      .map(
        ([k, v]) =>
          `<div class="td-aside-row"><dt>${escapeHtml(k)}</dt><dd title="${escapeHtml(String(v))}">${escapeHtml(String(v))}</dd></div>`,
      )
      .join('')

  const agentCode = String(task.assigned_to || '').trim()
  let links = ''
  if (sourceKey === 'role' && agentCode && state.taskId) {
    links += `<button type="button" class="td-aside-link td-aside-link--quiet" data-act="resume-employee-chat" data-agent-code="${escapeHtml(agentCode)}" data-task-id="${escapeHtml(state.taskId)}">续聊该任务</button>`
    const href = `#/proactive/${encodeURIComponent(agentCode)}/work/${encodeURIComponent(state.taskId)}`
    links += `<a class="td-aside-link td-aside-link--quiet" href="${href}">打开员工工作项</a>`
  }
  if (sourceKey === 'chat') {
    links += `<a class="td-aside-link td-aside-link--quiet" href="#/workflow/${encodeURIComponent(state.taskId)}">打开工作流</a>`
  }
  if (workflow && resolveSourceAppId(task)) {
    links += `<a class="td-aside-link td-aside-link--quiet" href="#/apps/${encodeURIComponent(resolveSourceAppId(task))}">打开工作流</a>`
  }
  if (parentId) {
    links += `<a class="td-aside-link td-aside-link--quiet" href="#/task/${encodeURIComponent(parentId)}">上游任务${parentName ? ` · ${escapeHtml(parentName.slice(0, 24))}` : ''}</a>`
  }
  if (childIds.length === 1) {
    links += `<a class="td-aside-link td-aside-link--quiet" href="#/task/${encodeURIComponent(childIds[0])}">下游任务</a>`
  } else if (childIds.length > 1) {
    links += childIds
      .map(
        (cid, i) =>
          `<a class="td-aside-link td-aside-link--quiet" href="#/task/${encodeURIComponent(cid)}">下游 #${i + 1} · ${escapeHtml(String(cid).slice(-8))}</a>`,
      )
      .join('')
  }

  const briefVisible = Boolean(page.querySelector('#task-brief-panel') && !page.querySelector('#task-brief-panel')?.hidden)
  const goalBlock =
    !briefVisible && goal
      ? (workflow
        ? `<details class="td-aside-fold"><summary>运行目标</summary><p>${escapeHtml(goal.length > 600 ? goal.slice(0, 600) + '…' : goal)}</p></details>`
        : `<div class="td-aside-block"><div class="td-aside-k">原始需求</div><p>${escapeHtml(desc.length > 320 ? desc.slice(0, 320) + '…' : desc)}</p></div>`)
      : ''

  el.innerHTML = `
    <h3 class="td-aside-title">${workflow ? '运行信息' : '任务信息'}</h3>
    <dl class="td-aside-dl">
      ${rowHtml(primary)}
    </dl>
    ${
      more.length
        ? `<details class="td-aside-more"><summary>更多信息</summary><dl class="td-aside-dl">${rowHtml(more)}</dl></details>`
        : ''
    }
    ${goalBlock}
    ${!briefVisible && expected ? `<div class="td-aside-block"><div class="td-aside-k">预期结果</div><p>${escapeHtml(expected.length > 240 ? expected.slice(0, 240) + '…' : expected)}</p></div>` : ''}
    ${links ? `<div class="td-aside-links">${links}</div>` : ''}
  `
}

function renderTaskStatusLine(page, state) {
  const el = page.querySelector('#task-status-line')
  if (!el) return
  const task = state.task
  if (!task) {
    el.textContent = ''
    return
  }
  const u = toUnifiedTaskStatus(task.status)
  const statusZh = formatUnifiedStatusZh(task.status)
  const started = formatDetailClock(task.started_at || task.startedAt || task.created_at)
  const finished = formatDetailClock(task.completed_at || task.completedAt || task.updated_at || task.updatedAt)
  const updated = formatDetailClock(task.updated_at || task.updatedAt)
  const obs = state.observability
  const durMs = Number(obs?.duration_ms)
  const dur = Number.isFinite(durMs) && durMs > 0
    ? formatDurationMs(durMs) + (obs?.duration_running ? '+' : '')
    : formatRunningDuration(task)
  const { subtaskCount, completedCount } = taskProgressMeta(task, state.subtasks)
  const workflow = isWorkflowAppTask(task)
  const kindZh = runKindLabelZh(resolveTaskRunKind(task))

  if (workflow) {
    const parts = []
    if (kindZh) parts.push(kindZh)
    parts.push(statusZh)
    if (started && finished && u !== 'running' && u !== 'planning') {
      parts.push(`${started} → ${finished}`)
    } else if (started) {
      parts.push(`${started} 开始`)
    } else if (finished) {
      parts.push(finished)
    }
    if (dur) parts.push(`耗时 ${dur}`)
    if (updated && u === 'running') parts.push(`最近更新 ${updated}`)
    if (subtaskCount > 0) {
      const ok = u === 'completed'
      parts.push(ok
        ? `${completedCount} / ${subtaskCount} 个节点成功`
        : nodeProgressLabel(completedCount, subtaskCount))
    }
    el.textContent = parts.join(' · ')
    el.dataset.group = toTaskStatusGroup(task.status)
    return
  }

  const icon = u === 'completed'
    ? '✓'
    : (u === 'failed' ? '✕' : (u === 'cancelled' ? '—' : '●'))
  const parts = [`${icon} ${statusZh}`]
  if (u === 'running' && updated) parts.push(`最近更新 ${updated}`)
  if (u === 'running' && dur) parts.push(`已运行 ${dur}`)
  else if (finished) parts.push(finished)
  else if (dur) parts.push(`耗时 ${dur}`)
  // 取消原因已在顶部 Banner 展示，状态行保持短句
  el.textContent = parts.join(' · ')
  el.dataset.group = toTaskStatusGroup(task.status)
}

function formatRunningDuration(task) {
  const startRaw = task?.started_at || task?.startedAt
  if (!startRaw) return ''
  const start = new Date(startRaw)
  if (Number.isNaN(start.getTime())) return ''
  const endRaw = task?.completed_at || task?.completedAt
  const end = endRaw ? new Date(endRaw) : new Date()
  if (Number.isNaN(end.getTime())) return ''
  const sec = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000))
  if (sec < 60) return `${sec}秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分`
  const h = Math.floor(min / 60)
  const rem = min % 60
  return rem ? `${h}小时${rem}分` : `${h}小时`
}

function updateMoreMenu(page, state) {
  const task = state.task
  const code = String(task?.assigned_to || '').trim()
  const isRole = normalizeTaskSource(task?.source) === 'role' && !!code
  const workBtn = page.querySelector('#btn-open-work-item')
  if (workBtn) {
    workBtn.hidden = !isRole
    if (isRole) {
      workBtn.textContent = '打开员工工作项'
      workBtn.dataset.href = `#/proactive/${encodeURIComponent(code)}/work/${encodeURIComponent(state.taskId)}`
    }
  }
  const resumeBtn = page.querySelector('#btn-resume-employee-chat')
  if (resumeBtn) {
    resumeBtn.hidden = !isRole || !state.taskId
    if (isRole && state.taskId) {
      resumeBtn.dataset.agentCode = code
      resumeBtn.dataset.taskId = state.taskId
    }
  }
}

async function loadTaskObservability(page, state) {
  const metaEl = page.querySelector('#task-meta')
  if (!metaEl || !state.taskId) return
  try {
    const obs = await api.getTaskObservability(state.taskId)
    state.observability = obs && typeof obs === 'object' ? obs : null
    renderTaskObservabilityMeta(metaEl, state.observability)
    renderTaskObsSubtasks(page, state)
    renderTaskStatusLine(page, state)
  } catch (e) {
    logTaskDetail('loadTaskObservability:error', { taskId: state.taskId, error: String(e) })
    state.observability = null
    if (metaEl) {
      metaEl.hidden = true
      metaEl.innerHTML = ''
    }
    renderTaskObsSubtasks(page, state)
  }
}

function renderTaskObservabilityMeta(el, obs) {
  if (!el) return
  if (!obs || obs.enabled === false) {
    el.hidden = true
    el.innerHTML = ''
    return
  }

  const chips = []
  const modelCalls = Number(obs.model_invocations) || 0
  const toolCalls = Number(obs.tool_invocations) || 0
  const tokens = obs.tokens || {}
  const totalTok = Number(tokens.total) || 0

  if (modelCalls > 0) {
    chips.push(
      `<span class="task-meta-chip" title="主控与子任务 worker 调用大模型 API 的总次数">`
      + `模型调用 ${modelCalls} 次</span>`,
    )
  }
  if (totalTok > 0) {
    const inTok = Number(tokens.input) || 0
    const outTok = Number(tokens.output) || 0
    chips.push(
      `<span class="task-meta-chip" title="输入 Token ${inTok.toLocaleString()} · 输出 Token ${outTok.toLocaleString()}">`
      + `Token ${formatCompactNum(totalTok)}</span>`,
    )
  }
  if (toolCalls > 0) {
    const err = Number(obs.tool_errors) || 0
    const errHint = err > 0 ? `，其中 ${err} 次失败` : ''
    chips.push(
      `<span class="task-meta-chip" title="Agent 调用内置/外部工具的总次数${errHint}">`
      + `工具 ${toolCalls} 次</span>`,
    )
  }
  if (obs.primary_model) {
    chips.push(
      `<span class="task-meta-chip" title="本任务 Token 消耗最多的模型">`
      + `模型 ${escapeHtml(obs.primary_model)}</span>`,
    )
  }
  const durMs = Number(obs.duration_ms)
  if (Number.isFinite(durMs) && durMs > 0) {
    const durText = formatDurationMs(durMs)
    const runningHint = obs.duration_running ? '（任务仍在进行，时间为累计值）' : ''
    chips.push(
      `<span class="task-meta-chip" title="从任务创建到结束（或当前时刻）的 wall-clock 总耗时${runningHint}">`
      + `耗时 ${durText}${obs.duration_running ? '+' : ''}</span>`,
    )
  }
  const runs = Number(obs.run_count) || 0
  if (runs > 0) {
    chips.push(
      `<span class="task-meta-chip" title="LangGraph 执行轮次（含重试与恢复）">`
      + `轮次 ${runs}</span>`,
    )
  }
  const lead = obs.lead
  if (lead && (lead.model_invocations || lead.tool_invocations || lead.tokens?.total)) {
    const leadLine = formatSubtaskObsLine(lead)
    if (leadLine) {
      chips.push(
        `<span class="task-meta-chip" title="主控 Lead 线程观测（不含子任务 worker）">`
        + `主控 ${escapeHtml(leadLine)}</span>`,
      )
    }
  }

  if (!chips.length) {
    el.hidden = true
    el.innerHTML = ''
    return
  }
  el.hidden = false
  el.innerHTML = `<h3 class="td-aside-title">运行观测</h3><div class="td-aside-chips">${chips.join('')}</div>`
}

function canOpenTaskWorkProcessPopup(task) {
  return Boolean(String(task?.assigned_to || '').trim())
}

async function openTaskWorkProcessPopup(page, state) {
  const task = state.task
  const agentCode = String(task?.assigned_to || '').trim()
  if (!agentCode) {
    toast('该任务没有关联员工，无法打开执行过程', 'warning')
    return false
  }
  if (!state.workProcessLive) {
    const { mountProactiveLiveProcess } = await import('../components/proactive-live-process.js')
    state.workProcessLive = mountProactiveLiveProcess(page)
  }
  const busy = toTaskStatusGroup(task?.status) === 'executing'
  const roundId = String(task?.round_id || task?.source_ref || '').trim()
  const taskName = String(task?.name || task?.title || '').trim()
  state.workProcessLive.open({
    agentCode,
    roleName: resolveDetailRoleLabel(task, state),
    busy,
    title: taskName || '执行过程',
    roundId,
    taskId: state.taskId,
    pollMs: busy ? 1000 : 4000,
  })
  return true
}

async function renderRoleWorkProcessInline(page, state) {
  const panel = page.querySelector('#task-obs-panel')
  const strip = page.querySelector('#task-obs-strip')
  const titleEl = page.querySelector('#task-obs-panel-title')
  const countEl = page.querySelector('#task-obs-panel-count')
  if (!strip) return

  const task = state.task
  const agentCode = String(task?.assigned_to || '').trim()
  if (!agentCode) {
    renderTaskLogsFallback(page, state)
    return
  }

  if (titleEl) titleEl.textContent = '执行过程'
  if (countEl) countEl.textContent = ''
  if (panel) panel.hidden = false

  if (!state.workProcessLive) {
    const { mountProactiveLiveProcess } = await import('../components/proactive-live-process.js')
    state.workProcessLive = mountProactiveLiveProcess(page)
  }

  // 员工任务统一走 SubtaskExecutionDrawer 弹窗，不再内嵌「上班轨迹」事件列表
  strip.innerHTML = `
    <div class="td-logs-empty">
      <p class="td-logs-empty-lead">与主对话子任务弹窗同款，按轮次展示工具调用与模型回复。</p>
      <p class="td-logs-empty-sub">点上方「执行过程」Tab 或下方按钮打开。</p>
      <div class="td-logs-empty-actions">
        <button type="button" class="btn btn-sm btn-primary" data-act="open-work-process">查看执行过程</button>
      </div>
    </div>`
}

function renderTaskLogsFallback(page, state) {
  const panel = page.querySelector('#task-obs-panel')
  const strip = page.querySelector('#task-obs-strip')
  const titleEl = page.querySelector('#task-obs-panel-title')
  const countEl = page.querySelector('#task-obs-panel-count')
  if (!strip) return

  if (state.workProcessLive?.isOpen?.()) {
    try {
      state.workProcessLive.close()
    } catch {
      /* ignore */
    }
  }

  if (titleEl) titleEl.textContent = '执行过程'
  if (countEl) countEl.textContent = ''
  if (panel) panel.hidden = false

  strip.innerHTML = `
    <div class="td-logs-empty">
      <p class="td-logs-empty-lead">暂无子任务执行记录。</p>
      <p class="td-logs-empty-sub">任务拆成多个步骤后，会在这里显示进度、执行者与模型/工具调用统计。</p>
    </div>`
}

function renderTaskObsSubtasks(page, state) {
  const panel = page.querySelector('#task-obs-panel')
  const strip = page.querySelector('#task-obs-strip')
  const titleEl = page.querySelector('#task-obs-panel-title')
  const countEl = page.querySelector('#task-obs-panel-count')
  if (!strip) return

  const task = state.task
  const agentCode = String(task?.assigned_to || '').trim()
  const isRole = normalizeTaskSource(task?.source) === 'role' && !!agentCode
  // 员工任务：直接复用上班轨迹，不再空提示跳转
  if (isRole) {
    void renderRoleWorkProcessInline(page, state)
    return
  }

  // 非员工任务：关闭可能残留的员工执行过程弹窗
  if (state.workProcessLive?.isOpen?.()) {
    try {
      state.workProcessLive.close()
    } catch {
      /* ignore */
    }
  }

  const subtasks = Array.isArray(state.subtasks) ? state.subtasks : []
  const workflow = isWorkflowAppTask(state.task)
  if (!subtasks.length) {
    renderTaskLogsFallback(page, state)
    return
  }

  const { completedCount } = taskProgressMeta(state.task, subtasks)
  if (titleEl) titleEl.textContent = workflow ? '执行过程' : '子任务进度'
  if (countEl) {
    countEl.textContent = workflow
      ? `${completedCount} / ${subtasks.length} 个节点`
      : `${completedCount}/${subtasks.length} 完成`
  }

  const obs = state.observability
  const obsById = new Map()
  if (obs && obs.enabled !== false && Array.isArray(obs.subtasks)) {
    for (const row of obs.subtasks) {
      const id = String(row?.subtask_id || row?.subtaskId || '').trim()
      if (id) obsById.set(id, row)
    }
  }

  if (workflow) {
    strip.innerHTML = renderWorkflowExecTreeHtml(subtasks, state, obsById)
    if (panel) panel.hidden = false
    strip.querySelectorAll('[data-subtask-id]').forEach((row) => {
      row.addEventListener('click', () => {
        const sid = row.getAttribute('data-subtask-id')
        if (sid) showSubtaskDetail(page, state, sid)
      })
    })
    return
  }

  const rowsHtml = subtasks.map((sub) => {
    const sid = String(sub?.id || '').trim()
    const name = String(sub?.name || sid || '子任务')
    const status = String(sub?.status || '').trim()
    const statusZh = formatTaskStatusZh(status, { fallback: '—' })
    const statusClass = taskStatusTagClass(status)
    const prog = Math.max(0, Math.min(100, parseInt(sub?.progress, 10) || 0))
    const assignee = String(sub?.assigned_to || '').trim()
    const assigneeLabel = assignee
      ? (resolveAssignedAgentDisplayName(assignee, state.agentCatalog || state.agents || []) || assignee)
      : ''
    const metrics = obsById.get(sid) || null
    const modelN = Number(metrics?.model_invocations) || 0
    const toolN = Number(metrics?.tool_invocations) || 0
    const tok = metrics?.tokens && typeof metrics.tokens === 'object' ? metrics.tokens : {}
    const inTok = Number(tok.input) || 0
    const outTok = Number(tok.output) || 0
    const durMs = Number(metrics?.duration_ms)
    const durText = Number.isFinite(durMs) && durMs > 0
      ? `${formatDurationMs(durMs)}${metrics?.duration_running ? '+' : ''}`
      : '—'
    const tokenText = inTok > 0 || outTok > 0
      ? `↓${formatCompactNum(inTok)} ↑${formatCompactNum(outTok)}`
      : '—'
    const hasMetrics = !!(metrics && (modelN || toolN || inTok || outTok || (Number.isFinite(durMs) && durMs > 0)))
    const liveStep = (toUnifiedTaskStatus(status) === 'running' || toUnifiedTaskStatus(status) === 'planning')
      ? taskLiveStepText(sub)
      : ''

    return `
      <tr class="task-obs-table-row${hasMetrics ? '' : ' is-empty'}${liveStep ? ' is-live' : ''}" data-subtask-id="${escapeHtml(sid)}">
        <td class="task-obs-table-name" title="${escapeHtml(liveStep || name)}">
          ${escapeHtml(name)}
          ${liveStep ? `<div class="task-obs-table-live">${escapeHtml(liveStep)}</div>` : ''}
        </td>
        <td class="task-obs-table-status"><span class="tag ${statusClass}" title="状态：${escapeHtml(statusZh)}">${escapeHtml(statusZh)}</span></td>
        <td class="task-obs-table-num">${prog > 0 ? `${prog}%` : '—'}</td>
        <td class="task-obs-table-agent" title="${escapeHtml(assigneeLabel)}">${assigneeLabel ? escapeHtml(assigneeLabel) : '—'}</td>
        <td class="task-obs-table-num">${durText}</td>
        <td class="task-obs-table-num">${modelN > 0 ? modelN : '—'}</td>
        <td class="task-obs-table-num">${toolN > 0 ? toolN : '—'}</td>
        <td class="task-obs-table-tokens">${tokenText}</td>
      </tr>`
  }).join('')

  strip.innerHTML = `
    <div class="task-obs-table-wrap">
      <table class="task-obs-table">
        <thead>
          <tr>
            <th>子任务</th>
            <th>状态</th>
            <th>进度</th>
            <th>执行者</th>
            <th title="子任务开始至结束的 wall-clock 耗时">耗时</th>
            <th title="该子任务调用大模型 API 的次数">模型</th>
            <th title="该子任务调用工具的次数">工具</th>
            <th title="输入 ↓ / 输出 ↑ Token 用量">Token</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`

  if (panel) panel.hidden = false
}

/** 按依赖关系缩进展示工作流节点（并行组同层） */
function renderWorkflowExecTreeHtml(subtasks, state, obsById) {
  const list = Array.isArray(subtasks) ? subtasks : []
  const byId = new Map(list.map((s) => [String(s.id || ''), s]))
  const depIdsOf = (sub) => {
    const wp = sub?.worker_profile
    const fromWp = Array.isArray(wp?.depends_on) ? wp.depends_on : []
    const fromRoot = Array.isArray(sub?.dependencies) ? sub.dependencies : []
    return [...new Set([...fromWp, ...fromRoot].map((id) => String(id || '').trim()).filter((id) => byId.has(id)))]
  }
  const depthMap = new Map()
  const getDepth = (id, stack = new Set()) => {
    if (depthMap.has(id)) return depthMap.get(id)
    if (stack.has(id)) return 0
    stack.add(id)
    const deps = depIdsOf(byId.get(id) || {})
    if (!deps.length) {
      depthMap.set(id, 0)
      return 0
    }
    const upstream = deps.map((d) => getDepth(d, stack))
    const d = 1 + Math.max(...upstream)
    depthMap.set(id, d)
    return d
  }
  list.forEach((s) => getDepth(String(s.id || '')))

  const groups = new Map()
  for (const sub of list) {
    const id = String(sub.id || '')
    const deps = depIdsOf(sub)
    const key = `${depthMap.get(id) || 0}|${[...deps].sort().join(',')}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(id)
  }

  const ordered = [...list].sort((a, b) => {
    const da = depthMap.get(String(a.id || '')) || 0
    const db = depthMap.get(String(b.id || '')) || 0
    if (da !== db) return da - db
    return 0
  })

  const items = ordered.map((sub) => {
    const sid = String(sub?.id || '').trim()
    const deps = depIdsOf(sub)
    const key = `${depthMap.get(sid) || 0}|${[...deps].sort().join(',')}`
    const group = groups.get(key) || [sid]
    const name = String(sub?.name || sid || '节点')
    const status = String(sub?.status || '').trim()
    const statusZh = formatTaskStatusZh(status, { fallback: '—' })
    const g = toTaskStatusGroup(status)
    const glyph = g === 'completed' || g === 'reviewed' ? '✓'
      : (g === 'failed' ? '!' : (g === 'executing' || g === 'planning' ? '●' : '○'))
    const assignee = String(sub?.assigned_to || '').trim()
    const assigneeLabel = assignee
      ? (resolveAssignedAgentDisplayName(assignee, state.agentCatalog || state.agents || []) || assignee)
      : ''
    const metrics = obsById?.get(sid) || null
    const durMs = Number(metrics?.duration_ms)
    const durText = Number.isFinite(durMs) && durMs > 0
      ? `${formatDurationMs(durMs)}${metrics?.duration_running ? '+' : ''}`
      : ''
    const metaBits = [statusZh, assigneeLabel, durText].filter(Boolean)
    const depth = depthMap.get(sid) || 0
    const isParallel = group.length > 1
    const liveStep = (g === 'executing' || g === 'planning') ? taskLiveStepText(sub) : ''
    return `
      <button type="button" class="td-flow-node is-${escapeHtml(g)}${isParallel ? ' is-parallel' : ''}${liveStep ? ' is-live' : ''}"
        data-subtask-id="${escapeHtml(sid)}" style="--flow-depth:${depth}"
        title="${escapeHtml(liveStep ? `${name}\n${liveStep}` : name)}">
        <span class="td-flow-glyph" aria-hidden="true">${glyph}</span>
        <span class="td-flow-body">
          <span class="td-flow-name">${escapeHtml(name)}</span>
          ${liveStep ? `<span class="td-flow-step">${escapeHtml(liveStep)}</span>` : ''}
          <span class="td-flow-meta">${escapeHtml(metaBits.join(' · '))}</span>
        </span>
      </button>`
  }).join('')

  return `<div class="td-flow-tree" role="list">${items}</div>`
}

/* Supervisor 面板已隐藏
function updateSupervisorPanel(page, state) {
  const status = page.querySelector('#supervisor-status')
  const message = page.querySelector('#supervisor-message')
  const log = page.querySelector('#supervisor-log')

  const taskStatus = state.task?.status || 'pending'

  if (taskStatus === 'executing') {
    status.textContent = '🟢 执行中'
    status.className = 'supervisor-status active'
    message.textContent = 'Supervisor 正在协调子任务执行...'

    if (state.supervisorLog) {
      log.innerHTML = state.supervisorLog.map(entry =>
        `<div class="log-entry"><span class="log-time">${entry.time}</span><span class="log-msg">${escapeHtml(entry.msg)}</span></div>`
      ).join('')
    }
  } else if (taskStatus === 'planning') {
    status.textContent = '🔵 规划中'
    status.className = 'supervisor-status planning'
    message.textContent = 'Supervisor 正在分析任务并拆解子任务...'
  } else if (taskStatus === 'completed') {
    status.textContent = '✅ 完成'
    status.className = 'supervisor-status completed'
    message.textContent = '所有子任务已完成'
  } else if (taskStatus === 'failed') {
    status.textContent = '❌ 失败'
    status.className = 'supervisor-status failed'
    message.textContent = state.task.error || '任务执行失败'
  } else {
    status.textContent = '⚪ 待机'
    status.className = 'supervisor-status idle'
    message.textContent = '点击「开始执行」启动任务'
  }
}
*/

function updateTaskStatusTag(page, status) {
  const line = page.querySelector('#task-status-line')
  if (!line) return
  line.textContent = formatTaskStatusZh(status, { fallback: '待处理' })
}

function updateButtons(page, state) {
  const btnPause = page.querySelector('#btn-pause')
  const btnCancel = page.querySelector('#btn-cancel-task')
  if (!btnPause) return
  const taskStatus = normalizeTaskStatusKey(state.task?.status)
  const u = toUnifiedTaskStatus(taskStatus)

  if (isTaskPausableStatus(taskStatus)) {
    btnPause.style.display = 'inline-flex'
    btnPause.textContent = '⏸ 暂停'
    btnPause.className = 'btn btn-warning btn-sm'
  } else if (taskStatus === 'paused') {
    btnPause.style.display = 'inline-flex'
    btnPause.textContent = '▶ 继续'
    btnPause.className = 'btn btn-success btn-sm'
  } else {
    btnPause.style.display = 'none'
  }

  if (btnCancel) {
    const showCancel = isTaskCancellableStatus(taskStatus) && (u === 'running' || u === 'planning' || u === 'queued' || u === 'pending' || taskStatus === 'paused')
    btnCancel.style.display = showCancel ? 'inline-flex' : 'none'
  }
}

/** 兼容旧调用名：同步更多菜单（仅 chat 显示计划/工作流） */
function updateChatOnlyHeroActions(page, task) {
  // loadTaskDetail 会再调 sync；这里仅按 task 刷新菜单项
  const fake = { task, taskId: String(task?.id || '') }
  updateMoreMenu(page, fake)
}

function resolveSourceAppId(task) {
  if (!task || typeof task !== 'object') return ''
  return String(task.source_app_id || task.sourceAppId || '').trim()
}

function resolveSourceAppName(task) {
  if (!task || typeof task !== 'object') return ''
  return String(task.source_app_name || task.sourceAppName || '').trim()
}

function isWorkflowAppTask(task) {
  if (!task) return false
  const src = normalizeTaskSource(task.source)
  return src === 'workflow' || !!resolveSourceAppId(task)
}

function resolveTaskRunKind(task) {
  const raw = String(task?.run_kind || task?.runKind || '').trim().toLowerCase()
  if (raw === 'debug' || raw === '调试') return 'debug'
  if (raw === 'scheduled' || raw === 'cron' || raw === '定时') return 'scheduled'
  if (raw === 'production' || raw === 'formal' || raw === '正式' || raw === 'prod') return 'production'
  return isWorkflowAppTask(task) ? 'debug' : ''
}

function runKindLabelZh(kind) {
  if (kind === 'debug') return '调试运行'
  if (kind === 'scheduled') return '定时触发'
  if (kind === 'production') return '正式运行'
  return ''
}

function taskDetailDisplayName(task) {
  if (isWorkflowAppTask(task)) {
    const app = resolveSourceAppName(task)
    if (app) return app
  }
  return String(task?.name || '').trim() || '未命名任务'
}

function nodeProgressLabel(completedCount, subtaskCount) {
  return `节点进度 ${completedCount} / ${subtaskCount}`
}

/** 来自 App 运行时：展示溯源芯片 +「再跑一次」 */
function updateAppProvenanceUi(page, task) {
  const provEl = page.querySelector('#task-app-provenance')
  const btnRerun = page.querySelector('#btn-rerun-app')
  const appId = resolveSourceAppId(task)
  const appName = resolveSourceAppName(task) || appId

  if (!appId) {
    if (provEl) {
      provEl.hidden = true
      provEl.innerHTML = ''
    }
    if (btnRerun) btnRerun.hidden = true
    return
  }

  if (provEl) {
    const ver = task.source_app_version ?? task.sourceAppVersion
    const verHint = ver != null && ver !== '' ? ` · v${ver}` : ''
    provEl.hidden = false
    provEl.innerHTML = `
      <a class="td-aside-link" href="#/apps/${encodeURIComponent(appId)}" title="${escAttr(appId)}">
        来自工作流：${escHtml(appName)}${escHtml(verHint)} ›
      </a>
    `
  }
  if (btnRerun) btnRerun.hidden = false
}

function escAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function handleRerunFromApp(page, state) {
  const appId = resolveSourceAppId(state.task)
  if (!appId) {
    toast.warning('该任务不是从工作流运行来的')
    return
  }
  window.location.hash = `#/apps/${encodeURIComponent(appId)}/run`
}

async function handleSaveTaskAsApp(page, state) {
  const task = state.task
  if (!task) {
    toast.error('任务未加载')
    return
  }
  const hasPlan = !!(task.plan_goal || task.plan_steps || task.plan_steps_json)
  if (!hasPlan) {
    toast.warning('任务尚无计划，无法另存为工作流')
    return
  }
  promptSaveTaskAsApp({
    taskId: state.taskId,
    defaultName: String(task.name || '').trim() || '未命名工作流',
    defaultDescription: taskDescriptionForDisplay(task) || '',
  })
}

async function handleStartButton(page, state) {
  const taskStatus = state.task?.status

  // 开始按钮仅在 pending 状态可用
  if (taskStatus !== 'pending') {
    return
  }

  // 首次开始任务
  toast('任务开始执行', 'success')
  state.task.status = 'planning'
  state.task.subtasks = state.task.subtasks || []

  try {
    await api.startTaskPlanning(state.taskId)
    toast('任务已启动', 'success')
  } catch (e) {
    toast('启动失败: ' + e, 'error')
  }

  updateButtons(page, state)
  renderSubtasks(page, state)
  updateTaskStats(page, state)
}

async function handleRestartButton(page, state) {
  const btnRestart = page.querySelector('#btn-restart')
  const taskStatus = state.task?.status

  // 防止重复点击
  if (btnRestart.disabled) return

  // 如果任务正在执行中，显示确认对话框
  if (taskStatus === 'executing' || taskStatus === 'planning') {
    const confirmed = await showConfirm(
      '【警告】任务正在执行中，确定要重新开始吗？\n\n将创建全新的任务执行，原任务会被归档。'
    )
    if (!confirmed) return
  }

  try {
    btnRestart.disabled = true
    btnRestart.textContent = '↻ 创建新任务...'

    toast('正在创建新任务...', 'info')

    // 调用后端重启接口 - 返回新任务信息
    const result = await api.restartTask(state.taskId)

    if (!result.success || !result.new_task_id) {
      throw new Error('创建新任务失败')
    }

    const newTaskId = result.new_task_id
    const newThreadId = result.new_thread_id
    const newProjectId = result.new_project_id

    toast(`新任务已创建: ${newTaskId}`, 'success')

    // 优先使用后端在 thread metadata 写入的 session_key，避免同一 thread 产生两个会话记录
    const newSessionKey = result.new_session_key || `agent:main:task-${newTaskId}`

    // 设置 pending 数据用于跳转到新任务的对话页面
    sessionStorage.setItem('evopanel_pending_shell_session', newSessionKey)
    sessionStorage.setItem('evopanel_pending_shell_thread', newThreadId || '')
    sessionStorage.setItem('evopanel_pending_shell_task_id', newTaskId)
    sessionStorage.removeItem('evopanel_pending_shell_processed')

    // 直接跳转到实时对话页面查看新任务的执行
    window.location.hash = '#/chat'

  } catch (e) {
    toast('创建新任务失败: ' + e, 'error')
    // 恢复按钮状态
    updateButtons(page, state)
    btnRestart.disabled = false
    btnRestart.textContent = '↻ 重新开始'
  }
}

async function handlePauseButton(page, state) {
  const taskStatus = normalizeTaskStatusKey(state.task?.status)
  const btnPause = page.querySelector('#btn-pause')

  if (btnPause.disabled) return

  const originalStatus = taskStatus
  btnPause.disabled = true

  try {
    if (isTaskPausableStatus(taskStatus)) {
      btnPause.textContent = '⏸ 暂停中...'
      await api.pauseTask(state.taskId)
      state.task.status = 'paused'
      toast('任务已暂停', 'success')
    } else if (taskStatus === 'paused') {
      btnPause.textContent = '▶ 继续中...'
      const resp = await api.resumeTask(state.taskId)
      state.task.status = resp?.status || resp?.data?.status || 'planned'
      toast('任务已继续', 'success')
    }
    updateButtons(page, state)
    setupOutputPolling(page, state)
  } catch (e) {
    state.task.status = originalStatus
    updateButtons(page, state)
    toast('操作失败: ' + e, 'error')
  } finally {
    btnPause.disabled = false
    await loadTaskDetail(page, state)
  }
}

async function showAddSubtaskDialog(page, state) {
  const availableSubtasks = state.subtasks.filter(t => t.status !== 'executing')
  const dependencyOptions = availableSubtasks.map(t => ({ value: t.id, label: t.name || t.id }))

  showModal({
    title: '添加子任务',
    fields: [
      { name: 'name', label: '子任务名称', value: '', placeholder: '例如：搜索竞品信息' },
      { name: 'description', label: '任务描述', value: '', placeholder: '详细描述子任务内容' },
      ...(dependencyOptions.length > 0 ? [{ name: 'dependencies', label: '依赖任务', type: 'multiselect', options: dependencyOptions, value: [] }] : []),
    ],
    onConfirm: async (result) => {
      const name = (result.name || '').trim()
      if (!name) {
        toast('请输入子任务名称', 'error')
        return
      }

      try {
        await api.addSubtask(state.taskId, name, result.description || '', result.dependencies || [])
        toast('子任务已添加', 'success')
        await loadTaskDetail(page, state)
      } catch (e) {
        toast('添加失败: ' + e, 'error')
      }
    }
  })
}

function showAssignDialog(page, state, subtaskId) {
  const agents = [
    { value: 'researcher', label: '研究员 Agent' },
    { value: 'writer', label: '写作 Agent' },
    { value: 'coder', label: '代码 Agent' },
    { value: 'general', label: '通用 Agent' },
  ]

  showModal({
    title: '分配子任务',
    fields: [
      { name: 'agent', label: '选择执行者', type: 'select', options: agents, value: '' },
    ],
    onConfirm: async (result) => {
      if (!result.agent) {
        toast('请选择执行者', 'error')
        return
      }

      try {
        await api.assignSubtask(state.taskId, subtaskId, result.agent)
        await loadTaskDetail(page, state)
        toast('已分配给 ' + result.agent, 'success')
      } catch (e) {
        toast('分配失败: ' + e, 'error')
      }
    }
  })
}

async function deleteSubtask(page, state, subtaskId) {
  const yes = await showConfirm('确定删除该子任务？')
  if (!yes) return

  try {
    await api.deleteSubtask(state.taskId, subtaskId)
    toast('已删除', 'success')
    await loadTaskDetail(page, state)
  } catch (e) {
    toast('删除失败: ' + e, 'error')
  }
}

async function viewSubtaskResult(page, state, subtaskId) {
  const subtask = state.subtasks.find(t => t.id === subtaskId)
  if (!subtask) return

  showModal({
    title: `子任务结果: ${subtask.name}`,
    width: 700,
    fields: [
      {
        name: 'result',
        label: '执行结果',
        type: 'textarea',
        value: normalizeSubtaskResultForDisplay(subtask.result) || '无结果',
        readonly: true,
        rows: 15,
      },
    ],
    onConfirm: () => {},
  })
}

/** 主任务级：弹窗查看结构化 plan（复用主对话 PlanDetailModal）。 */
async function showTaskPlanModal(page, state) {
  try {
    const fresh = await api.getTask(state.taskId)
    state.task = fresh
    state.subtasks = fresh.subtasks || []
    updateChatOnlyHeroActions(page, state.task)
  } catch (e) {
    logTaskDetail('showTaskPlanModal:refreshFailed', { error: String(e) })
  }
  const goal = String(state.task?.plan_goal || '').trim()
  let steps = state.task?.plan_steps
  if (!Array.isArray(steps)) {
    const raw = state.task?.plan_steps_json
    if (typeof raw === 'string' && raw.trim().startsWith('[')) {
      try {
        steps = JSON.parse(raw)
      } catch {
        steps = []
      }
    } else {
      steps = []
    }
  }
  if (!goal && !(Array.isArray(steps) && steps.length)) {
    toast('当前任务尚未绑定 Plan', 'info')
    return
  }
  const opened = openTaskPlanModal({ task: state.task })
  if (!opened) {
    toast('计划弹窗尚未就绪，请稍后重试', 'warning')
  }
}

async function showSubtaskDetail(page, state, subtaskId) {
  const sid = String(subtaskId || '').trim()
  const tid = String(state.taskId || '').trim()
  if (!sid || !tid) return
  window.location.hash = `#/workflow/${encodeURIComponent(tid)}?subtask=${encodeURIComponent(sid)}`
}

/** 上游依赖名称（不含标题）：depends_on + dependencies 去重后解析为子任务名称，顿号分隔 */
function formatUpstreamTaskNamesOnly(subtask, allSubtasks) {
  const wp = subtask?.worker_profile
  const fromWp = Array.isArray(wp?.depends_on) ? wp.depends_on : []
  const fromRoot = Array.isArray(subtask?.dependencies) ? subtask.dependencies : []
  const ids = [...new Set([...fromWp, ...fromRoot].map((id) => String(id || '').trim()).filter(Boolean))]
  if (!ids.length) return ''
  const byId = new Map((allSubtasks || []).map((s) => [String(s.id), s]))
  const parts = ids.map((id) => {
    const st = byId.get(id)
    const name = st && String(st.name || '').trim()
    return name || id
  })
  return parts.join('、')
}

function getSubtaskStatusIcon(status) {
  const key = normalizeTaskStatusKey(status)
  const icons = {
    pending: '<span class="status-dot status-pending"></span>',
    planning: '<span class="status-dot status-pending"></span>',
    planned: '<span class="status-dot status-pending"></span>',
    executing: '<span class="status-spinner"></span>',
    in_progress: '<span class="status-spinner"></span>',
    running: '<span class="status-spinner"></span>',
    active: '<span class="status-spinner"></span>',
    verifying: '<span class="status-spinner"></span>',
    reflecting: '<span class="status-spinner"></span>',
    completed: '<span class="status-check">✓</span>',
    done: '<span class="status-check">✓</span>',
    success: '<span class="status-check">✓</span>',
    failed: '<span class="status-failed">✕</span>',
    error: '<span class="status-failed">✕</span>',
    timed_out: '<span class="status-failed">✕</span>',
    cancelled: '<span class="status-cancelled">⏸</span>',
    canceled: '<span class="status-cancelled">⏸</span>',
  }
  return icons[key] || icons.pending
}

function getSubtaskStatusText(status) {
  return formatTaskStatusZh(status, { fallback: '待处理' })
}

function getSubtaskStatusTagClass(status) {
  return taskStatusTagClass(status)
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function extractTaskId() {
  const hash = window.location.hash || ''
  const match = hash.match(/^#\/task\/([^/?]+)/)
  return match ? match[1] : null
}
