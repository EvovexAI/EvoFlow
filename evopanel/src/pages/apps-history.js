/**
 * 应用运行历史 — 独立分页页 + 大屏结果弹层
 * 路由：#/apps/:id/history
 * 点「查看结果」打开居中大弹层（含节点产出预览），不是右侧窄栏。
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm } from '../components/modal.js'
import { navigate, getCurrentRoute } from '../router.js'
import { appRunControlFlags } from '../lib/app-run-controls.js'
import { setAgentsDisplayCache } from '../lib/agents-display-cache.js'
import {
  appRunInspectShellHtml,
  createAppRunInspectController,
  escHtml,
  RUN_STATUS,
} from '../lib/app-run-inspect.js'

const PAGE_SIZE = 20

function parseAppIdFromRoute() {
  const path = getCurrentRoute().split('?')[0]
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'apps' && parts[2] === 'history') return parts[1] || ''
  return ''
}

function formatParams(params) {
  if (!params || typeof params !== 'object') return '无参数'
  const keys = Object.keys(params)
  if (!keys.length) return '无参数'
  return keys.map((k) => `${k}=${params[k]}`).join(', ')
}

/** @type {ReturnType<typeof createAppRunInspectController> | null} */
let stepTranscript = null

export function cleanup() {
  try {
    stepTranscript?.destroy?.()
  } catch {
    /* ignore */
  }
  stepTranscript = null
}

export async function render() {
  cleanup()
  const appId = parseAppIdFromRoute()
  const page = document.createElement('div')
  page.className = 'page apps-history-page'

  if (!appId) {
    page.innerHTML =
      '<div class="apps-history-empty">无效的工作流 ID，<a href="#/apps">返回工作流列表</a></div>'
    return page
  }

  page.innerHTML = `
    <div class="page-header apps-history-header">
      <div>
        <button type="button" class="btn btn-ghost btn-sm apps-history-back" id="btn-back-canvas">← 返回画布</button>
        <h1 class="page-title" id="apps-history-title">运行历史</h1>
        <p class="page-desc">分页浏览记录；点「查看结果」打开大屏详情，可预览各节点与最终 HTML 产出</p>
      </div>
      <div class="page-actions">
        <button type="button" class="btn btn-secondary" id="btn-refresh">刷新</button>
      </div>
    </div>
    <div class="apps-history-layout">
      <div class="apps-history-list-col">
        <div class="apps-history-table-wrap" id="history-list">
          <div class="page-loader">
            <div class="page-loader-spinner"></div>
            <div class="page-loader-text">加载中…</div>
          </div>
        </div>
        <div class="apps-history-pager" id="history-pager" hidden></div>
      </div>
    </div>
    <div class="apps-history-modal-overlay" id="history-detail-overlay" hidden>
      <div class="apps-history-modal" id="history-detail" role="dialog" aria-modal="true" aria-label="运行结果">
        <div class="apps-history-detail-head">
          <div class="apps-history-detail-titles">
            <strong data-role="detail-title">运行结果</strong>
            <span data-role="detail-sub"></span>
          </div>
          <div class="apps-history-detail-head-actions">
            <button type="button" class="btn btn-xs btn-ghost" id="btn-open-canvas" hidden>在画布打开</button>
            <button type="button" class="btn btn-xs btn-ghost" id="btn-close-detail" aria-label="关闭">✕</button>
          </div>
        </div>
        <div class="apps-history-detail-main" data-role="inspect-root"></div>
      </div>
    </div>
  `

  page.querySelector('#btn-back-canvas').addEventListener('click', () => navigate(`/apps/${appId}`))
  page.querySelector('#btn-close-detail').addEventListener('click', () => closeDetail())
  page.querySelector('#history-detail-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeDetail()
  })
  page.querySelector('#btn-open-canvas').addEventListener('click', () => {
    const rid = selectedRunId
    if (rid) navigate(`/apps/${appId}?run=${encodeURIComponent(rid)}`)
  })

  let appData = null
  let agentsCache = []
  let currentPage = 1
  let total = 0
  let loading = false
  let selectedRunId = ''
  let runStatus = null
  /** @type {string} */
  let detailGeneration = '0'

  const inspectRoot = page.querySelector('[data-role="inspect-root"]')
  if (inspectRoot) inspectRoot.innerHTML = appRunInspectShellHtml()
  const inspect = createAppRunInspectController({
    root: inspectRoot,
    getAppData: () => appData,
    getAgentsCache: () => agentsCache,
  })
  stepTranscript = inspect

  try {
    appData = await api.getApp(appId)
    const appName = String(appData?.name || '').trim()
    page.querySelector('#apps-history-title').textContent = appName
      ? `${appName} · 运行历史`
      : '运行历史'
  } catch {
    appData = null
  }

  try {
    agentsCache = await api.listAgents()
    setAgentsDisplayCache(agentsCache)
  } catch {
    agentsCache = []
  }

  function closeDetail() {
    selectedRunId = ''
    runStatus = null
    detailGeneration = String(Date.now())
    page.classList.remove('has-detail')
    page.querySelector('#history-detail-overlay')?.setAttribute('hidden', '')
    page.querySelector('#btn-open-canvas')?.setAttribute('hidden', '')
    try {
      inspect?.setRun?.({ runId: '', runStatus: null })
    } catch {
      /* ignore */
    }
    page.querySelectorAll('.apps-history-row.is-active').forEach((el) => el.classList.remove('is-active'))
  }

  function markActiveRow() {
    page.querySelectorAll('.apps-history-row').forEach((row) => {
      row.classList.toggle('is-active', row.dataset.runId === selectedRunId)
    })
  }

  function renderDetailBody() {
    const detailEl = page.querySelector('#history-detail')
    if (!detailEl || !runStatus) return
    const titleEl = detailEl.querySelector('[data-role="detail-title"]')
    const subEl = detailEl.querySelector('[data-role="detail-sub"]')
    const overall = String(runStatus.status || '').toLowerCase()
    const meta = RUN_STATUS[overall] || { label: overall || '未知', cls: 'pending' }
    if (titleEl) titleEl.textContent = `运行结果 · ${meta.label}`
    if (subEl) {
      const pct = Math.min(100, Math.max(0, Number(runStatus.progress) || 0))
      subEl.textContent = `${selectedRunId}${pct ? ` · ${pct}%` : ''}`
    }
    inspect.updateStatus(runStatus)
  }

  async function openRunDetail(runId) {
    const rid = String(runId || '').trim()
    if (!rid) {
      toast.error('该记录缺少运行 ID')
      return
    }
    selectedRunId = rid
    detailGeneration = String(Date.now())
    const gen = detailGeneration
    page.classList.add('has-detail')
    const overlay = page.querySelector('#history-detail-overlay')
    const detailEl = page.querySelector('#history-detail')
    overlay?.removeAttribute('hidden')
    detailEl?.removeAttribute('hidden')
    page.querySelector('#btn-open-canvas')?.removeAttribute('hidden')
    markActiveRow()

    const headEl = detailEl.querySelector('[data-role="step-head"]')
    if (headEl) headEl.innerHTML = '<div class="apps-history-step-empty">加载中…</div>'

    try {
      const status = await api.getAppRunStatus(rid)
      if (gen !== detailGeneration) return
      if (!status) throw new Error('未找到该次运行')
      runStatus = status
      inspect.setRun({ runId: rid, runStatus: status })
      const titleEl = detailEl.querySelector('[data-role="detail-title"]')
      const subEl = detailEl.querySelector('[data-role="detail-sub"]')
      const overall = String(status.status || '').toLowerCase()
      const meta = RUN_STATUS[overall] || { label: overall || '未知', cls: 'pending' }
      if (titleEl) titleEl.textContent = `运行结果 · ${meta.label}`
      if (subEl) {
        const pct = Math.min(100, Math.max(0, Number(status.progress) || 0))
        subEl.textContent = `${rid}${pct ? ` · ${pct}%` : ''}`
      }
    } catch (e) {
      if (gen !== detailGeneration) return
      if (headEl) {
        headEl.innerHTML = `<div class="apps-history-step-empty apps-history-empty--error">${escHtml(e.message || String(e))}</div>`
      }
    }
  }

  async function loadPage(pageNum) {
    if (loading) return
    loading = true
    currentPage = Math.max(1, pageNum)
    const listEl = page.querySelector('#history-list')
    const pagerEl = page.querySelector('#history-pager')
    listEl.innerHTML = `
      <div class="page-loader">
        <div class="page-loader-spinner"></div>
        <div class="page-loader-text">加载中…</div>
      </div>
    `
    try {
      const data = await api.listAppRuns(appId, PAGE_SIZE, { page: currentPage, pageSize: PAGE_SIZE })
      const items = Array.isArray(data?.items) ? data.items : []
      total = Number(data?.total) || 0
      const pageSize = Number(data?.page_size) || PAGE_SIZE
      const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1)
      if (currentPage > totalPages) {
        loading = false
        return loadPage(totalPages)
      }

      if (!items.length) {
        listEl.innerHTML = `
          <div class="apps-history-empty">
            <p>暂无运行记录</p>
            <p class="apps-history-empty-hint">在画布中点击「运行」后，记录会出现在这里</p>
            <button type="button" class="btn btn-primary btn-sm" id="btn-empty-back">返回画布</button>
          </div>`
        listEl.querySelector('#btn-empty-back')?.addEventListener('click', () => navigate(`/apps/${appId}`))
        pagerEl.hidden = true
        closeDetail()
        return
      }

      listEl.innerHTML = `
        <table class="apps-history-table">
          <thead>
            <tr>
              <th>状态</th>
              <th>参数</th>
              <th>进度</th>
              <th>开始</th>
              <th>结束</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${items
              .map((run) => {
                const meta = RUN_STATUS[run.status] || { label: run.status || '未知', cls: 'pending' }
                const runId = run.id || run.run_id || ''
                const created = run.created_at ? new Date(run.created_at).toLocaleString('zh-CN') : '—'
                const completed = run.completed_at
                  ? new Date(run.completed_at).toLocaleString('zh-CN')
                  : '—'
                const flags = appRunControlFlags(run.status)
                const paramStr = formatParams(run.parameters)
                return `
                  <tr class="apps-history-row" data-run-id="${escHtml(runId)}" data-task-id="${escHtml(run.task_id || '')}">
                    <td><span class="apps-history-status ${meta.cls}">${escHtml(meta.label)}</span></td>
                    <td class="apps-history-params" title="${escHtml(paramStr)}">${escHtml(paramStr)}</td>
                    <td class="apps-history-pct">${Number(run.progress) || 0}%</td>
                    <td class="apps-history-time">${escHtml(created)}</td>
                    <td class="apps-history-time">${escHtml(completed)}</td>
                    <td class="apps-history-actions">
                      <button type="button" class="btn btn-xs btn-secondary" data-role="view" ${runId ? '' : 'disabled'}>查看结果</button>
                      ${
                        flags.canCancel
                          ? `<button type="button" class="btn btn-xs btn-ghost" data-role="cancel" data-run-id="${escHtml(runId)}">取消</button>`
                          : ''
                      }
                    </td>
                  </tr>`
              })
              .join('')}
          </tbody>
        </table>`

      listEl.querySelectorAll('.apps-history-row').forEach((row) => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('[data-role="cancel"]')) return
          const rid = row.dataset.runId
          if (rid) void openRunDetail(rid)
        })
      })
      listEl.querySelectorAll('[data-role="view"]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          const row = btn.closest('.apps-history-row')
          const rid = row?.dataset.runId
          if (rid) void openRunDetail(rid)
        })
      })
      listEl.querySelectorAll('[data-role="cancel"]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation()
          const rid = btn.dataset.runId
          if (!rid) return
          const ok = await showConfirm('确定取消该次运行？')
          if (!ok) return
          try {
            await api.cancelAppRun(rid)
            toast.success('已取消')
            if (selectedRunId === rid) closeDetail()
            await loadPage(currentPage)
          } catch (err) {
            toast.error('取消失败: ' + (err?.message || err))
          }
        })
      })

      markActiveRow()

      const from = (currentPage - 1) * pageSize + 1
      const to = Math.min(total, (currentPage - 1) * pageSize + items.length)
      pagerEl.hidden = false
      pagerEl.innerHTML = `
        <div class="apps-history-pager-meta">共 ${total} 条 · 第 ${from}–${to} 条</div>
        <div class="apps-history-pager-actions">
          <button type="button" class="btn btn-sm btn-ghost" data-role="prev" ${currentPage <= 1 ? 'disabled' : ''}>上一页</button>
          <span class="apps-history-pager-page">${currentPage} / ${totalPages}</span>
          <button type="button" class="btn btn-sm btn-ghost" data-role="next" ${currentPage >= totalPages ? 'disabled' : ''}>下一页</button>
        </div>`
      pagerEl.querySelector('[data-role="prev"]')?.addEventListener('click', () => loadPage(currentPage - 1))
      pagerEl.querySelector('[data-role="next"]')?.addEventListener('click', () => loadPage(currentPage + 1))
    } catch (e) {
      listEl.innerHTML = `<div class="apps-history-empty apps-history-empty--error">加载失败: ${escHtml(e.message)}</div>`
      pagerEl.hidden = true
    } finally {
      loading = false
    }
  }

  page.querySelector('#btn-refresh').addEventListener('click', () => loadPage(currentPage))
  await loadPage(1)
  return page
}
