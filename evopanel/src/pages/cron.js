/**
 * 自动化 / Automation 页面
 * 现代化调度管理 UI — 对接 dev-api automation_* 路由
 * 调度解析与预览统一走 Gateway 后端
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm } from '../components/modal.js'
import { createSchedulePanel, cronToPlainZh, looksLikeCron as looksLikeCronShared } from '../lib/schedule-panel.js'
import { mountCronSelects, unmountCronSelects } from '../react/components/cron-selects.tsx'
import {
  bindListPager,
  paginateItems,
  readStoredPageSize,
  renderListPagerHtml,
  writeStoredPageSize,
} from '../components/list-pager.js'

const CRON_TASKS_PAGE_SIZE_KEY = 'evopanel_automation_tasks_page_size'
const CRON_RUNS_PAGE_SIZE_KEY = 'evopanel_automation_runs_page_size'

const esc = (s) => !s ? '' : String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

function pushTargetKey(channel, targetId) {
  const ch = String(channel || '').trim()
  const tid = String(targetId || '').trim()
  if (!ch || !tid) return ''
  return `${ch}:${tid}`
}

function parsePushTargetKey(key) {
  const raw = String(key || '').trim()
  const idx = raw.indexOf(':')
  if (idx <= 0) return { channel: '', targetId: '' }
  return { channel: raw.slice(0, idx), targetId: raw.slice(idx + 1) }
}

function pickDefaultPushTargetKey(targets) {
  if (!Array.isArray(targets) || !targets.length) return ''
  const feishuDefault = targets.find((t) => t.source === 'feishu_default')
  return String((feishuDefault || targets[0])?.id || '')
}

function pushTargetLabel(task, targets) {
  if (!task?.feishu_push_enabled) return ''
  const key = pushTargetKey(task.push_channel, task.push_target_id)
  const match = Array.isArray(targets) ? targets.find((t) => t.id === key) : null
  if (match?.label) return match.label
  if (task.push_channel) return `${task.push_channel} 推送`
  return '结果推送'
}

// ── 状态 ────────────────────────────────

let _tasks = []
let _pushTargetsCache = []
let _schedulerState = 'stopped' // running | stopped | error
let _schedulerDiag = null
let _loadSeq = 0
let _pageEl = null
let _runningTaskIds = new Set() // 防重复「立即运行」
let _drawerTaskId = null
let _runsFilterTaskId = null // legacy; optional filter on standalone ledger
let _runsRowCache = {}
let _runsAllRows = []
let _runsFilters = { range: '7d', status: '', trigger: '', taskId: '', q: '' }
let _bootQuery = { tab: 'tasks', date: '7d', task: '' }
let _tasksPage = 1
let _tasksPageSize = readStoredPageSize(CRON_TASKS_PAGE_SIZE_KEY)
let _runsPage = 1
let _runsPageSize = readStoredPageSize(CRON_RUNS_PAGE_SIZE_KEY)

// ── 预设快捷 ───────────────────────────

const CRON_PRESETS = [
  { label: '每小时', freq: 'hourly' },
  { label: '每天 9:00', freq: 'daily', hour: 9 },
  { label: '每天 18:00', freq: 'daily', hour: 18 },
  { label: '周一至周五 9:00', freq: 'weekly', hour: 9, dow: [1, 2, 3, 4, 5] },
  { label: '每周一 10:00', freq: 'weekly', dow: 1, hour: 10 },
]

function q(sel) { return _pageEl ? _pageEl.querySelector(sel) : document.querySelector(sel) }

// ══════════════════════════════════════
// 初始化 & 渲染
// ══════════════════════════════════════

export async function render() {
  const page = document.createElement('div')
  page.className = 'page cron-page'
  _pageEl = page

  const boot = readCronQueryFromHash()
  _bootQuery = boot
  _runsFilterTaskId = boot.task || null
  _runsFilters = {
    ..._runsFilters,
    range: normalizeRunsRange(boot.date),
    taskId: boot.task || '',
  }
  page.innerHTML = renderPage(boot.tab)
  applyCronTabVisibility(page, boot.tab)
  bindPageEvents(page)
  bindCronTabs(page, boot)
  await refresh()
  try {
    if (sessionStorage.getItem('evopanel_pending_cron_create') === '1') {
      sessionStorage.removeItem('evopanel_pending_cron_create')
      void openCreateModal()
    }
  } catch {
    /* ignore */
  }
  return page
}

function todayIsoDate() {
  const d = new Date()
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

function normalizeRunsRange(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (s === 'today' || s === '7d' || s === 'all') return s
  return '7d'
}

function readCronQueryFromHash() {
  try {
    const hash = String(window.location.hash || '').replace(/^#/, '')
    const qi = hash.indexOf('?')
    const sp = qi >= 0 ? new URLSearchParams(hash.slice(qi + 1)) : new URLSearchParams()
    const tab = String(sp.get('tab') || 'tasks').trim() === 'runs' ? 'runs' : 'tasks'
    const date = normalizeRunsRange(sp.get('date') || sp.get('range') || '7d')
    const task = String(sp.get('task') || sp.get('automation') || '').trim()
    return { tab, date, task }
  } catch {
    return { tab: 'tasks', date: '7d', task: '' }
  }
}

function writeCronQueryToHash({ tab, date, task }) {
  const qs = new URLSearchParams()
  if (tab && tab !== 'tasks') qs.set('tab', tab)
  if (date) qs.set('date', date)
  if (task) qs.set('task', task)
  const path = String(window.location.hash || '').replace(/^#/, '').split('?')[0] || '/cron'
  const base = path === '/automation' ? '/automation' : '/cron'
  const q = qs.toString()
  const next = q ? `${base}?${q}` : base
  const cur = String(window.location.hash || '').replace(/^#/, '')
  if (cur === next) return
  window.location.hash = next
}

function bindCronTabs(page, boot) {
  page.querySelectorAll('[data-cron-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.cronTab === 'runs' ? 'runs' : 'tasks'
      writeCronQueryToHash({ tab, date: normalizeRunsRange(boot.date || _runsFilters.range || '7d'), task: '' })
    })
  })
}

/** Ensure task cards / status bar never leak onto the runs ledger view. */
function applyCronTabVisibility(page, tab) {
  const isRuns = tab === 'runs'
  const list = page?.querySelector('#cronList')
  const pager = page?.querySelector('#cronListPager')
  const panel = page?.querySelector('#cronRunsPanel')
  const status = page?.querySelector('#cronStatusBar')
  if (list) list.hidden = isRuns
  if (pager) pager.hidden = isRuns
  if (panel) panel.hidden = !isRuns
  if (status) status.hidden = isRuns
  page?.querySelectorAll('[data-cron-tab]').forEach((btn) => {
    const active = (btn.dataset.cronTab === 'runs') === isRuns
    btn.classList.toggle('is-active', active)
    btn.setAttribute('aria-selected', active ? 'true' : 'false')
  })
}

function renderPage(activeTab = 'tasks') {
  const tab = activeTab === 'runs' ? 'runs' : 'tasks'
  return `
      <div class="cron-header">
        <div class="cron-title-group">
          <div>
            <h1 class="cron-title">自动化</h1>
            <p class="cron-subtitle">自动化调度管理 \u2014 创建、监控和管理周期性 / 一次性任务</p>
          </div>
        </div>
        <div class="cron-toolbar">
          <button class="cron-btn primary" data-action="create">\uFF0B 新建任务</button>
        </div>
      </div>

      <div class="cron-tabs" role="tablist" aria-label="自动化视图">
        <button type="button" class="cron-tab${tab === 'tasks' ? ' is-active' : ''}" data-cron-tab="tasks" role="tab" aria-selected="${tab === 'tasks' ? 'true' : 'false'}">调度任务</button>
        <button type="button" class="cron-tab${tab === 'runs' ? ' is-active' : ''}" data-cron-tab="runs" role="tab" aria-selected="${tab === 'runs' ? 'true' : 'false'}">运行记录</button>
      </div>

      <div class="cron-status-bar" id="cronStatusBar" ${tab === 'runs' ? 'hidden' : ''}>
        <div class="cron-status-main">
          <div class="cron-status-indicator">
            <span class="cron-dot stopped" id="schedulerDot"></span>
            <span id="schedulerLabel">调度器未启动</span>
          </div>
          <p class="cron-status-hint" id="schedulerHint" hidden></p>
          <div class="cron-status-actions" id="schedulerActions" hidden>
            <button type="button" class="cron-btn sm primary" data-action="start-scheduler">启动调度器</button>
          </div>
        </div>
        <div class="cron-stats">
          <span class="cron-stat">已启用 <strong id="statActive">0</strong></span>
          <span class="cron-stat">已暂停 <strong id="statPaused">0</strong></span>
          <span class="cron-stat">共 <strong id="statTotal">0</strong> 个</span>
        </div>
      </div>

      <div class="cron-list" id="cronList" ${tab === 'runs' ? 'hidden' : ''}></div>
      <div class="pro-list-pager-wrap" id="cronListPager" ${tab === 'runs' ? 'hidden' : ''}></div>
      <div class="cron-runs-panel" id="cronRunsPanel" ${tab === 'runs' ? '' : 'hidden'}>
        <div class="cron-runs-loading">正在加载运行记录…</div>
      </div>
      <div class="cron-drawer-root" id="cronDrawer" hidden>
        <div class="cron-drawer-mask" data-action="close-drawer"></div>
        <aside class="cron-drawer" role="dialog" aria-label="规则详情">
          <header class="cron-drawer__head">
            <div>
              <h2 class="cron-drawer__title" id="cronDrawerTitle">规则详情</h2>
              <div class="cron-drawer__subtitle" id="cronDrawerSubtitle"></div>
            </div>
            <button type="button" class="cron-drawer__close" data-action="close-drawer" aria-label="关闭">×</button>
          </header>
          <div class="cron-drawer__body" id="cronDrawerBody"></div>
          <footer class="cron-drawer__foot" id="cronDrawerFoot"></footer>
        </aside>
      </div>
  `
}

async function renderRunsPanel(page, dateKey = '7d', filterTaskId = '') {
  const panel = page.querySelector('#cronRunsPanel')
  if (!panel) return
  panel.hidden = false
  panel.innerHTML = '<div class="cron-runs-loading">正在加载运行记录…</div>'

  _runsFilters = {
    range: normalizeRunsRange(dateKey || _runsFilters.range || '7d'),
    status: String(_runsFilters.status || ''),
    trigger: String(_runsFilters.trigger || ''),
    taskId: String(filterTaskId || _runsFilters.taskId || '').trim(),
    q: String(_runsFilters.q || ''),
  }
  _runsFilterTaskId = _runsFilters.taskId || null

  const rows = []
  _runsRowCache = {}
  try {
    const nameById = new Map(
      (Array.isArray(_tasks) ? _tasks : []).map((t) => [String(t.id || ''), t]),
    )
    const filterTask = String(_runsFilters.taskId || '').trim()
    let runs = []
    if (filterTask) {
      const res = await api.automationHistory(filterTask, 50)
      runs = (Array.isArray(res?.runs) ? res.runs : []).map((r) => ({ ...r, task_id: filterTask }))
    } else {
      const res = await api.automationRecentRuns(200)
      runs = Array.isArray(res?.runs) ? res.runs : []
    }
    for (const r of runs) {
      const taskId = String(r.task_id || r.taskId || filterTask || '').trim()
      const t = nameById.get(taskId) || {}
      const ts = Date.parse(String(r.started_at || r.created_at || r.finished_at || ''))
      const rowId = `${taskId}-${r.run_id || r.id || ts}`
      const preview = runPreviewText(r)
      const row = {
        id: rowId,
        name: t.name || taskId || '—',
        status: String(r.status || r.state || 'unknown'),
        time: Number.isFinite(ts) ? new Date(ts).toLocaleString('zh-CN') : '—',
        ts: Number.isFinite(ts) ? ts : 0,
        output: preview,
        taskId,
        duration: Number(r.duration_seconds) || 0,
        hasChat: !!(r.session_key && r.langgraph_thread_id),
        collabTaskId: String(r.collab_task_id || '').trim(),
        triggerType: String(r.trigger_type || '').trim(),
        summary: String(r.summary || '').trim(),
        error: String(r.error || '').trim(),
        diag: String(r.output || '').trim(),
        sessionKey: String(r.session_key || '').trim(),
        threadId: String(r.langgraph_thread_id || '').trim(),
        appId: String(r.app_id || t.app_id || '').trim(),
        runId: String(r.run_id || '').trim(),
      }
      _runsRowCache[rowId] = row
      rows.push(row)
    }
  } catch (e) {
    panel.innerHTML = `<div class="cron-runs-empty">加载失败：${esc(String(e?.message || e))}</div>`
    return
  }
  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0))
  _runsAllRows = rows
  paintRunsPanel(panel)
}

function startOfLocalDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function filterRunsRows(all, f) {
  const range = normalizeRunsRange(f.range)
  const status = String(f.status || '').trim()
  const trigger = String(f.trigger || '').trim().toLowerCase()
  const taskId = String(f.taskId || '').trim()
  const q = String(f.q || '').trim().toLowerCase()
  const today0 = startOfLocalDay()
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  return (all || []).filter((r) => {
    if (range === 'today' && (r.ts || 0) < today0) return false
    if (range === '7d' && (r.ts || 0) < weekAgo) return false
    if (status && normalizeRunStatus(r.status) !== status) return false
    if (trigger) {
      const t = String(r.triggerType || '').toLowerCase()
      if (trigger === 'manual' && t !== 'manual') return false
      if (trigger === 'schedule' && !(t === 'schedule' || t === 'cron')) return false
    }
    if (taskId && String(r.taskId) !== taskId) return false
    if (q) {
      const hay = `${r.name || ''} ${r.output || ''} ${r.summary || ''} ${r.error || ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

function runsFilterBarHtml(f) {
  const taskOpts = (Array.isArray(_tasks) ? _tasks : [])
    .map((t) => `<option value="${esc(t.id)}"${String(f.taskId) === String(t.id) ? ' selected' : ''}>${esc(t.name || t.id)}</option>`)
    .join('')
  const sel = (name, val, options) =>
    `<label class="cron-runs-filter-field"><span>${esc(name)}</span><select data-runs-filter="${esc(options.key)}">${options.items
      .map(([v, label]) => `<option value="${esc(v)}"${String(val) === String(v) ? ' selected' : ''}>${esc(label)}</option>`)
      .join('')}</select></label>`
  return `
    <div class="cron-runs-filter" id="cronRunsFilter">
      ${sel('时间', f.range, { key: 'range', items: [['today', '今日'], ['7d', '近7天'], ['all', '全部']] })}
      ${sel('状态', f.status, {
        key: 'status',
        items: [
          ['', '全部'],
          ['success', '成功'],
          ['failed', '失败'],
          ['running', '运行中'],
          ['queued', '排队中'],
        ],
      })}
      ${sel('触发', f.trigger, {
        key: 'trigger',
        items: [
          ['', '全部'],
          ['schedule', '定时'],
          ['manual', '手动'],
        ],
      })}
      <label class="cron-runs-filter-field">
        <span>自动化</span>
        <select data-runs-filter="taskId">
          <option value="">全部</option>
          ${taskOpts}
        </select>
      </label>
      <label class="cron-runs-filter-field cron-runs-filter-field--grow">
        <span>搜索</span>
        <input type="search" data-runs-filter="q" value="${esc(f.q || '')}" placeholder="名称 / 摘要" />
      </label>
    </div>`
}

function paintRunsPanel(panel, opts = {}) {
  if (!panel) return
  const filtered = filterRunsRows(_runsAllRows, _runsFilters)
  const filterHtml = runsFilterBarHtml(_runsFilters)
  if (!_runsAllRows.length) {
    panel.innerHTML = `
      ${filterHtml}
      <div class="cron-runs-empty">
        <strong>暂无运行记录</strong>
        <div style="margin-top:8px">
          <button type="button" class="cron-btn sm" data-action="create">新建自动化</button>
        </div>
      </div>`
    bindRunsFilterEvents(panel)
    return
  }
  if (!filtered.length) {
    panel.innerHTML = `
      ${filterHtml}
      <div class="cron-runs-empty">
        <strong>没有符合筛选的记录</strong>
        <div style="margin-top:8px;color:var(--text-tertiary)">试试放宽时间、状态或自动化条件</div>
      </div>`
    bindRunsFilterEvents(panel)
    restoreRunsSearchFocus(panel, opts)
    return
  }
  const paged = paginateItems(filtered, _runsPage, _runsPageSize)
  _runsPage = paged.page
  _runsPageSize = paged.pageSize
  const shown = paged.items
  const bodyRows = shown
    .map((r, idx) => {
      const st = normalizeRunStatus(r.status)
      const failed = st === 'failed'
      const rowNo = paged.from + idx
      const primary = r.collabTaskId
        ? `<button type="button" class="cron-btn sm primary" data-action="open-collab-task" data-collab-id="${esc(r.collabTaskId)}">打开任务</button>`
        : `<button type="button" class="cron-btn sm" data-action="open-run" data-run-id="${esc(r.id)}">查看</button>`
      const secondary = r.collabTaskId
        ? `<button type="button" class="cron-btn sm" data-action="open-run" data-run-id="${esc(r.id)}">详情</button>`
        : ''
      return `<tr class="tl-row${failed ? ' tl-row--failed' : ''}">
        <td class="tl-col-idx">${rowNo}</td>
        <td class="tl-col-time">${esc(r.time)}</td>
        <td class="tl-col-name"><span class="tl-name">${esc(r.name)}</span></td>
        <td class="tl-col-source">${esc(formatTriggerZh(r.triggerType))}</td>
        <td class="tl-col-status">${cronRunStatusHtml(r.status)}</td>
        <td class="tl-col-summary"><div class="cron-runs-summary">${esc(r.output || '—')}</div></td>
        <td class="tl-col-dur">${r.duration ? esc(formatDurationSec(r.duration)) : '—'}</td>
        <td class="tl-col-ops"><div class="tl-ops">${primary}${secondary}</div></td>
      </tr>`
    })
    .join('')
  panel.innerHTML = `
    ${filterHtml}
    <div class="cron-runs-head">运行记录 · 共 ${paged.total} 条${_runsAllRows.length > filtered.length ? ` · 已加载 ${_runsAllRows.length}` : ''}</div>
    <div class="tl-table-scroll cron-runs-table-wrap">
      <table class="tl-table tl-table--ledger cron-runs-table">
        <thead>
          <tr>
            <th class="tl-col-idx">序号</th>
            <th class="tl-col-time">时间</th>
            <th class="tl-col-name">自动化</th>
            <th class="tl-col-source">触发</th>
            <th class="tl-col-status">状态</th>
            <th class="tl-col-summary">摘要</th>
            <th class="tl-col-dur">耗时</th>
            <th class="tl-col-ops">操作</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    <div class="pro-list-pager-wrap" id="cronRunsPager">${renderListPagerHtml({
      total: paged.total,
      page: paged.page,
      pageCount: paged.pageCount,
      pageSize: paged.pageSize,
      from: paged.from,
      to: paged.to,
      unit: '条',
    })}</div>`
  bindRunsFilterEvents(panel)
  bindListPager(panel.querySelector('#cronRunsPager'), {
    page: paged.page,
    pageCount: paged.pageCount,
    onPage: (next) => {
      _runsPage = next
      paintRunsPanel(panel)
    },
    onPageSize: (nextSize) => {
      _runsPageSize = nextSize
      _runsPage = 1
      writeStoredPageSize(CRON_RUNS_PAGE_SIZE_KEY, nextSize)
      paintRunsPanel(panel)
    },
  })
  restoreRunsSearchFocus(panel, opts)
}

function restoreRunsSearchFocus(panel, opts = {}) {
  if (!opts.focusSearch) return
  const input = panel.querySelector('[data-runs-filter="q"]')
  if (!input) return
  input.focus()
  try {
    const len = input.value.length
    input.setSelectionRange(len, len)
  } catch {
    /* ignore */
  }
}

function bindRunsFilterEvents(panel) {
  const bar = panel.querySelector('#cronRunsFilter')
  if (!bar || bar._bound) return
  bar._bound = true
  let searchTimer = 0
  const apply = (key, value, opts = {}) => {
    _runsFilters = { ..._runsFilters, [key]: value }
    _runsPage = 1
    if (key === 'range' || key === 'taskId') {
      _bootQuery = { ..._bootQuery, date: _runsFilters.range, task: _runsFilters.taskId || '' }
      writeCronQueryToHash({ tab: 'runs', date: _runsFilters.range, task: _runsFilters.taskId || '' })
    }
    paintRunsPanel(panel, opts)
  }
  bar.addEventListener('change', (e) => {
    const el = e.target?.closest?.('[data-runs-filter]')
    if (!el) return
    const key = el.getAttribute('data-runs-filter')
    if (!key || key === 'q') return
    apply(key, el.value || '')
  })
  bar.addEventListener('input', (e) => {
    const el = e.target?.closest?.('[data-runs-filter="q"]')
    if (!el) return
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => apply('q', el.value || '', { focusSearch: true }), 180)
  })
}

function formatTriggerZh(raw) {
  const s = String(raw || '').toLowerCase()
  if (s === 'manual') return '手动'
  if (s === 'schedule' || s === 'cron') return '定时'
  return s || '—'
}

function cronRunStatusHtml(raw) {
  const st = normalizeRunStatus(raw)
  const tone = {
    queued: 'pending',
    running: 'executing',
    success: 'completed',
    failed: 'failed',
    cancelled: 'cancelled',
    skipped: 'cancelled',
  }[st] || 'pending'
  return `<span class="tl-status tl-status--${tone}"><span class="tl-dot"></span>${esc(formatRunStatusZh(raw))}</span>`
}

/** Prefer model summary / error over diagnostic ops log for list previews. */
function runPreviewText(r) {
  const summary = String(r?.summary || '').trim()
  if (summary) return summary.slice(0, 200)
  const err = String(r?.error || '').trim()
  if (err) return err.slice(0, 200)
  const out = String(r?.output || r?.message || '').trim()
  if (!out) return ''
  const noisy = /^(langgraph:|chat_session:|push:|chat_transcript:)/i
  const human = out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .find((l) => !noisy.test(l))
  return (human || '').slice(0, 200)
}

/** 页面内事件委托（仅处理页面内的 action） */
function bindPageEvents(root) {
  if (root._cronEventsBound) return
  root._cronEventsBound = true
  root.addEventListener('click', async (e) => {
    try {
      const moreBtn = e.target.closest?.('[data-action="toggle-more"]')
      if (moreBtn && root.contains(moreBtn)) {
        e.preventDefault()
        e.stopPropagation()
        root.querySelectorAll('.cron-more.is-open').forEach((w) => {
          if (w !== moreBtn.closest('.cron-more')) {
            w.classList.remove('is-open')
            const p = w.querySelector('.cron-more-panel')
            if (p) p.hidden = true
          }
        })
        const wrap = moreBtn.closest('.cron-more')
        const panel = wrap?.querySelector('.cron-more-panel')
        const open = wrap?.classList.toggle('is-open')
        moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
        if (panel) panel.hidden = !open
        return
      }
      if (!e.target.closest?.('.cron-more')) {
        root.querySelectorAll('.cron-more.is-open').forEach((w) => {
          w.classList.remove('is-open')
          const p = w.querySelector('.cron-more-panel')
          if (p) p.hidden = true
        })
      }

      const btn = e.target.closest?.('[data-action]')
      if (!btn || !root.contains(btn)) {
        const card = e.target.closest?.('.cron-card[data-task-id]')
        if (card && root.contains(card) && !e.target.closest?.('button, a, input, .cron-card-actions, .cron-more')) {
          openRuleDrawer(card.dataset.taskId)
        }
        return
      }

      const action = btn.dataset.action
      const taskId = btn.dataset.id
      e.preventDefault()
      e.stopPropagation()

      switch (action) {
        case 'create':
          await openCreateModal()
          break
        case 'edit':
          closeRuleDrawer()
          await openEditModal(taskId)
          break
        case 'delete':
          if (await showConfirm('确认删除此自动化规则？\n\n将同时删除该规则下的运行历史记录。')) {
            await deleteTask(taskId)
            closeRuleDrawer()
          }
          break
        case 'run':
          await runTask(taskId, btn)
          break
        case 'pause':
          await pauseTask(taskId)
          toast('已暂停规则：不会再按计划触发，已在运行的实例不受影响', 'success')
          break
        case 'resume':
          await resumeTask(taskId)
          toast('已启用规则', 'success')
          break
        case 'history':
        case 'open-history':
        case 'runs':
          if (taskId) openRunsForTask(taskId)
          else openRunsTab()
          break
        case 'open-run': {
          const runId = String(btn.dataset.runId || '').trim()
          openRunDetail(runId)
          break
        }
        case 'open-collab-task': {
          const collabId = String(btn.dataset.collabId || '').trim()
          if (collabId) window.location.hash = `#/task/${encodeURIComponent(collabId)}`
          break
        }
        case 'open-drawer':
          openRuleDrawer(taskId)
          break
        case 'close-drawer':
          closeRuleDrawer()
          break
        case 'start-scheduler':
          await startScheduler()
          break
        case 'clear-runs-filter':
          openRunsTab()
          break
        default:
          break
      }
    } catch (err) {
      console.error('[cron] click handler error:', err)
      toast(String(err?.message || err), 'error')
    }
  })
}

// ══════════════════════════════════════
// 数据加载
// ══════════════════════════════════════

/** After automationStart: surface Gateway reality (dev-api attaches `gateway_scheduler`). */
function maybeToastGatewaySchedulerStatus(res) {
  const g = res && res.gateway_scheduler
  if (!g) return
  if (g.fetch_error) {
    toast('无法连接定时调度服务，请确认服务已启动后重试', 'error')
    return
  }
  const st = g.http_status
  if (st && st >= 400) {
    toast('定时调度服务异常，请稍后重试', 'error')
    return
  }
  if (!g.backend_env_enabled) {
    toast('后端已关闭自动化功能。如需启用，请联系管理员检查服务配置。', 'warning')
    return
  }
  if (!g.backend_loop_running) {
    toast('定时调度未正常运行，请查看服务日志或联系管理员', 'warning')
    return
  }
  const lt = g.last_tick
  if (lt && lt.active_tasks > 0 && !lt.channel_service_running) {
    toast('消息渠道未启动：有活跃任务但无法触发，请先启动消息渠道', 'warning')
    return
  }
  if (
    lt &&
    lt.active_tasks > 0 &&
    Array.isArray(lt.fired_task_ids) &&
    lt.fired_task_ids.length === 0 &&
    lt.channel_service_running
  ) {
    const sample = (lt.skipped_reasons_sample || []).slice(0, 3).join('；')
    toast(
      sample
        ? `近一分钟未触发：${sample}…`
        : '近一分钟未触发，请确认定时规则与时区设置',
      'info',
    )
  }
}

async function refresh() {
  _loadSeq++
  const seq = _loadSeq
  try {
    const [res, pushMeta, schedStatus] = await Promise.all([
      api.automationList(),
      api.automationFeishuPushDefault().catch(() => ({ targets: [] })),
      api.automationSchedulerStatus().catch(() => null),
    ])
    if (_loadSeq !== seq) return
    _tasks = res.automations || []
    _pushTargetsCache = Array.isArray(pushMeta?.targets) ? pushMeta.targets : []
    applySchedulerStatus(schedStatus)
    renderList()
    updateStats()
    if (_drawerTaskId) openRuleDrawer(_drawerTaskId, { silent: true })
    if (_bootQuery.tab === 'runs' && _pageEl) {
      applyCronTabVisibility(_pageEl, 'runs')
      await renderRunsPanel(_pageEl, _bootQuery.date, _runsFilterTaskId || _bootQuery.task || '')
    }
  } catch (err) {
    if (seq === _loadSeq) renderEmpty(err.message)
  }
}

function applySchedulerStatus(status) {
  _schedulerDiag = status && typeof status === 'object' ? status : null
  if (!_schedulerDiag) {
    _schedulerState = 'stopped'
  } else if (_schedulerDiag.backend_env_enabled === false) {
    _schedulerState = 'error'
  } else if (_schedulerDiag.backend_loop_running) {
    _schedulerState = 'running'
  } else {
    _schedulerState = 'stopped'
  }
  updateSchedulerUI()
}

function updateSchedulerUI() {
  const dot = q('#schedulerDot')
  const label = q('#schedulerLabel')
  const hint = q('#schedulerHint')
  const actions = q('#schedulerActions')
  if (!dot || !label) return
  const running = _schedulerState === 'running'
  const errored = _schedulerState === 'error'
  dot.className = `cron-dot ${_schedulerState === 'running' ? 'running' : (_schedulerState === 'error' ? 'error' : 'stopped')}`
  if (running) {
    label.textContent = '调度服务正常'
    if (hint) { hint.hidden = true; hint.textContent = '' }
    if (actions) actions.hidden = true
  } else if (errored) {
    label.textContent = '调度服务异常'
    if (hint) {
      hint.hidden = false
      hint.textContent = '调度环境异常或已关闭；已启用规则不会按计划触发。'
    }
    if (actions) actions.hidden = false
  } else {
    label.textContent = '调度器未启动'
    if (hint) {
      hint.hidden = false
      hint.textContent = '已启用规则不会按计划触发。'
    }
    if (actions) actions.hidden = false
  }
}

function updateStats() {
  const enabled = _tasks.filter((t) => ruleStatusOf(t) === 'enabled').length
  const paused = _tasks.filter((t) => ruleStatusOf(t) === 'paused').length
  setEl('statActive', enabled)
  setEl('statPaused', paused)
  setEl('statTotal', _tasks.length)
  updateSchedulerUI()
}
function setEl(id, val) { const el = q(`#${id}`); if (el) el.textContent = val }

async function startScheduler() {
  try {
    const res = await api.automationStart()
    maybeToastGatewaySchedulerStatus(res)
    applySchedulerStatus(res?.gateway_scheduler || await api.automationSchedulerStatus().catch(() => null))
    if (_schedulerState === 'running') toast('调度器已启动', 'success')
    await refresh()
  } catch (e) {
    toast('启动失败：' + (e?.message || e), 'error')
  }
}

// ══════════════════════════════════════
// 状态文案（三类分离）
// ══════════════════════════════════════

/** 自动化规则状态 */
function ruleStatusOf(t) {
  const st = String(t?.status || '').toLowerCase()
  if (st === 'paused') return 'paused'
  if (t?.schedule_ok === false && !isOnceTask(t)) return 'config_error'
  const sched = String(t?.schedule_cron || t?.schedule || '').trim()
  if (!isOnceTask(t) && sched && /FREQ=/i.test(sched) && !looksLikeCron(sched)) return 'config_error'
  if (!isOnceTask(t) && !sched && !t?.rrule) return 'config_error'
  return 'enabled'
}

function formatRuleStatusZh(t) {
  const k = ruleStatusOf(t)
  return { enabled: '已启用', paused: '已暂停', config_error: '配置异常' }[k] || '已启用'
}

function normalizeRunStatus(raw) {
  const s = String(raw || '').toLowerCase()
  if (['queued', 'pending', 'waiting'].includes(s)) return 'queued'
  if (['running', 'in_progress', 'active'].includes(s)) return 'running'
  if (['success', 'ok', 'completed', 'done'].includes(s)) return 'success'
  if (['fail', 'failed', 'error', 'timeout'].includes(s)) return 'failed'
  if (['cancelled', 'canceled'].includes(s)) return 'cancelled'
  if (['skipped', 'skip'].includes(s)) return 'skipped'
  return s || 'unknown'
}

function formatRunStatusZh(raw) {
  return {
    queued: '排队中',
    running: '运行中',
    success: '成功',
    failed: '失败',
    cancelled: '已取消',
    skipped: '已跳过',
  }[normalizeRunStatus(raw)] || String(raw || '—')
}

function looksLikeCron(s) {
  const t = String(s || '').trim()
  if (!t || /FREQ=/i.test(t)) return false
  return t.split(/\s+/).length >= 5
}

function isOnceTask(t) {
  return String(t?.schedule_type || '') === 'once' || (!!t?.scheduled_at && !looksLikeCron(t?.schedule))
}

function formatDurationSec(sec) {
  const n = Math.max(0, Number(sec) || 0)
  if (n < 60) return `${n}s`
  const m = Math.floor(n / 60)
  const r = n % 60
  return r ? `${m}分${r}秒` : `${m}分钟`
}

function formatClock(raw) {
  if (!raw) return '—'
  try {
    const d = new Date(raw)
    if (Number.isNaN(d.getTime())) return String(raw)
    return d.toLocaleString('zh-CN', { hour12: false })
  } catch {
    return String(raw)
  }
}

function nextRunLabel(t) {
  if (_schedulerState !== 'running') return '调度器未启动，暂无法执行'
  if (ruleStatusOf(t) === 'paused') return '规则已暂停'
  if (ruleStatusOf(t) === 'config_error') return '配置异常，无法计算'
  if (t?.next_run_at) return formatClock(t.next_run_at)
  return '—'
}

function hasLiveRun(t) {
  return !!t?.has_active_run || normalizeRunStatus(t?.last_run_status) === 'running'
}

// ══════════════════════════════════════
// 任务卡片列表
// ══════════════════════════════════════

function renderList() {
  const list = q('#cronList')
  if (!list) return
  const pagerWrap = q('#cronListPager')
  if (!_tasks.length) {
    list.innerHTML = renderEmpty()
    if (pagerWrap) pagerWrap.innerHTML = ''
    return
  }
  const paged = paginateItems(_tasks, _tasksPage, _tasksPageSize)
  _tasksPage = paged.page
  _tasksPageSize = paged.pageSize
  list.innerHTML = paged.items.map((t) => renderCard(t)).join('')
  if (pagerWrap) {
    pagerWrap.innerHTML = renderListPagerHtml({
      total: paged.total,
      page: paged.page,
      pageCount: paged.pageCount,
      pageSize: paged.pageSize,
      from: paged.from,
      to: paged.to,
      unit: '个',
    })
    bindListPager(pagerWrap, {
      page: paged.page,
      pageCount: paged.pageCount,
      onPage: (next) => {
        _tasksPage = next
        renderList()
      },
      onPageSize: (nextSize) => {
        _tasksPageSize = nextSize
        _tasksPage = 1
        writeStoredPageSize(CRON_TASKS_PAGE_SIZE_KEY, nextSize)
        renderList()
      },
    })
  }
}

function renderEmpty(msg) {
  return `<div class="cron-empty"><h3>暂无自动化</h3><p>${msg || '点击「新建任务」创建你的第一个自动化调度任务'}</p></div>`
}

function renderCard(t) {
  const ruleSt = ruleStatusOf(t)
  const isPaused = ruleSt === 'paused'
  const humanSchedule = humanScheduleForCard(t)
  const live = hasLiveRun(t)
  const badgeClass = ruleSt === 'paused' ? 'badge-paused' : (ruleSt === 'config_error' ? 'badge-error' : 'badge-active')
  const badgeText = formatRuleStatusZh(t)
  const lastResult = t.last_run_status ? formatRunStatusZh(t.last_run_status) : '—'
  const lastDur = t.last_run_duration_seconds != null && t.last_run_at
    ? formatDurationSec(t.last_run_duration_seconds)
    : '—'
  const id = esc(t.id)
  const busy = _runningTaskIds.has(String(t.id))

  return `
    <div class="cron-card ${isPaused ? 'paused' : ''}" data-task-id="${id}">
      <div class="cron-card-header">
        <div class="cron-card-left">
          <div class="cron-card-name-wrap">
            <h3 class="cron-card-name">${esc(t.name)}</h3>
            ${live ? '<span class="cron-live-pill">运行中</span>' : ''}
          </div>
        </div>
        <span class="cron-badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="cron-card-body cron-card-body--meta">
        <div>
          <div class="cron-field-label">执行计划</div>
          <div class="cron-field-value">${esc(humanSchedule)}</div>
        </div>
        <div>
          <div class="cron-field-label">下次运行</div>
          <div class="cron-field-value">${esc(nextRunLabel(t))}</div>
        </div>
        <div>
          <div class="cron-field-label">上次运行</div>
          <div class="cron-field-value">${esc(t.last_run_at ? formatClock(t.last_run_at) : '—')}</div>
        </div>
        <div>
          <div class="cron-field-label">上次结果</div>
          <div class="cron-field-value">${esc(lastResult)}${lastDur !== '—' ? ` · ${esc(lastDur)}` : ''}</div>
        </div>
      </div>
      <div style="margin-top:6px;">
        <div class="cron-field-label">${t.app_id ? '绑定工作流' : '任务描述'}</div>
        <div class="cron-prompt-preview">${esc(t.app_id ? (t.app_name || t.app_id) : (t.prompt || '—'))}</div>
      </div>
      ${t.feishu_push_enabled ? `<div style="margin-top:8px;font-size:12px;color:var(--accent, #3b82f6);">\u{1F4E8} ${esc(pushTargetLabel(t, _pushTargetsCache))}</div>` : ''}
      ${t.agent_code ? `<div style="margin-top:4px;font-size:11px;color:var(--text-tertiary, #94a3b8);">\u{1F916} ${esc(t.agent_code)}${t.model_name ? ' · ' + esc(t.model_name) : ''}</div>` : ''}
      <div class="cron-card-actions">
        <button type="button" class="cron-btn sm primary" data-action="run" data-id="${id}" ${busy ? 'disabled' : ''}>${busy ? '提交中…' : '立即运行'}</button>
        ${isPaused
          ? `<button type="button" class="cron-btn sm success" data-action="resume" data-id="${id}">启用规则</button>`
          : `<button type="button" class="cron-btn sm" data-action="pause" data-id="${id}">暂停规则</button>`}
        <button type="button" class="cron-btn sm" data-action="runs" data-id="${id}">运行记录</button>
        <button type="button" class="cron-btn sm" data-action="edit" data-id="${id}">编辑</button>
        <div class="cron-more">
          <button type="button" class="cron-btn sm" data-action="toggle-more" aria-haspopup="menu" aria-expanded="false">更多</button>
          <div class="cron-more-panel" role="menu" hidden>
            <button type="button" class="cron-more-item danger" role="menuitem" data-action="delete" data-id="${id}">删除规则</button>
          </div>
        </div>
      </div>
    </div>`
}

/** 列表卡片：自然语言计划；从不展示 RRULE / 原始 cron */
function humanScheduleForCard(t) {
  const summary = String(t?.schedule_summary || '').trim()
  if (summary && !/FREQ=/i.test(summary) && !looksLikeCronShared(summary)) {
    return summary
  }
  if (isOnceTask(t) && t.scheduled_at) return `一次性: ${formatClock(t.scheduled_at)}`
  const cron = String(t?.schedule_cron || (looksLikeCron(t?.schedule) ? t.schedule : '') || '').trim()
  if (cron) return cronToPlainZh(cron)
  const rr = String(t?.rrule || '').trim()
  if (rr && /FREQ=/i.test(rr)) return rruleHumanFallback(rr)
  if (summary) return cronToPlainZh(summary)
  return '未知'
}

function rruleHumanFallback(rrule) {
  const r = String(rrule || '').toUpperCase()
  const hour = Number((r.match(/BYHOUR=(\d+)/) || [])[1] || 9)
  const minute = Number((r.match(/BYMINUTE=(\d+)/) || [])[1] || 0)
  const pad = (n) => String(n).padStart(2, '0')
  if (r.includes('FREQ=DAILY')) return `每天 ${pad(hour)}:${pad(minute)}`
  if (r.includes('FREQ=HOURLY')) return '每小时'
  if (r.includes('FREQ=WEEKLY')) return `每周 ${pad(hour)}:${pad(minute)}`
  return '周期性任务'
}

async function deleteTask(id){await api.automationDelete(id);toast('已删除','success');await refresh()}

/** 手动运行走 Gateway ``run_async``；防重复提交 */
async function runTask(id, btnEl) {
  const key = String(id || '')
  if (!key || _runningTaskIds.has(key)) return
  _runningTaskIds.add(key)
  if (btnEl) {
    btnEl.disabled = true
    btnEl.textContent = '提交中…'
  }
  try {
    await api.automationRun(id, { run_async: true })
    toast('已加入执行队列', 'success')
    await refresh()
    // Async runs finish after queue — refresh history shortly if viewing runs.
    if (_bootQuery.tab === 'runs') {
      window.setTimeout(() => {
        if (_pageEl && _bootQuery.tab === 'runs') {
          void renderRunsPanel(_pageEl, _bootQuery.date, _runsFilterTaskId || _bootQuery.task || '')
        }
      }, 2800)
    }
  } catch (e) {
    toast('触发失败：' + (e?.message || e), 'error')
  } finally {
    _runningTaskIds.delete(key)
    renderList()
    if (_drawerTaskId === key) openRuleDrawer(key, { silent: true })
  }
}
async function pauseTask(id){await api.automationPause(id);await refresh()}
async function resumeTask(id){await api.automationResume(id);await refresh()}

function openRunsForTask(taskId) {
  const id = String(taskId || '').trim()
  _runsFilterTaskId = id || null
  _runsFilters = { ..._runsFilters, taskId: id }
  _runsPage = 1
  closeRuleDrawer()
  writeCronQueryToHash({ tab: 'runs', date: _runsFilters.range || '7d', task: id })
}

function openRunsTab() {
  _runsFilterTaskId = null
  _runsFilters = { ..._runsFilters, taskId: '' }
  _runsPage = 1
  closeRuleDrawer()
  writeCronQueryToHash({ tab: 'runs', date: _runsFilters.range || '7d', task: '' })
}

function openRuleDrawer(taskId, { silent = false } = {}) {
  const id = String(taskId || '').trim()
  const task = _tasks.find((t) => String(t.id) === id)
  const root = q('#cronDrawer')
  const body = q('#cronDrawerBody')
  const foot = q('#cronDrawerFoot')
  const title = q('#cronDrawerTitle')
  const subtitle = q('#cronDrawerSubtitle')
  if (!root || !body || !task) {
    if (!silent) toast('规则不存在或已刷新', 'warning')
    return
  }
  _drawerTaskId = id
  root.hidden = false
  if (title) title.textContent = task.name || id
  if (subtitle) {
    subtitle.innerHTML = `<span class="cron-badge ${ruleStatusOf(task) === 'paused' ? 'badge-paused' : (ruleStatusOf(task) === 'config_error' ? 'badge-error' : 'badge-active')}">${esc(formatRuleStatusZh(task))}</span>`
      + (hasLiveRun(task) ? ' <span class="cron-live-pill">运行中</span>' : '')
  }
  const agent = [task.agent_code, task.model_name].filter(Boolean).join(' · ') || '—'
  const err = String(task.last_run_error || '').trim()
  const boundApp = String(task.app_id || '').trim()
  const contentHtml = boundApp
    ? `<p class="cron-drawer-prompt">工作流：<strong>${esc(task.app_name || boundApp)}</strong><br/><code style="font-size:11px">${esc(boundApp)}</code></p>
       ${task.prompt ? `<p class="cron-drawer-prompt" style="margin-top:8px;opacity:.85">${esc(task.prompt)}</p>` : ''}`
    : `<p class="cron-drawer-prompt">${esc(task.prompt || '—')}</p>`
  body.innerHTML = `
    <section class="cron-drawer-section">
      <h4>执行计划</h4>
      <p>${esc(humanScheduleForCard(task))}</p>
      <dl class="cron-drawer-dl">
        <div><dt>下次运行</dt><dd>${esc(nextRunLabel(task))}</dd></div>
        <div><dt>上次运行</dt><dd>${esc(task.last_run_at ? formatClock(task.last_run_at) : '—')}</dd></div>
        <div><dt>上次结果</dt><dd>${esc(task.last_run_status ? formatRunStatusZh(task.last_run_status) : '—')}</dd></div>
        <div><dt>上次耗时</dt><dd>${esc(task.last_run_duration_seconds != null && task.last_run_at ? formatDurationSec(task.last_run_duration_seconds) : '—')}</dd></div>
      </dl>
    </section>
    <section class="cron-drawer-section">
      <h4>执行内容</h4>
      ${contentHtml}
    </section>
    <section class="cron-drawer-section">
      <h4>使用的智能体</h4>
      <p>${esc(boundApp ? '由工作流步骤指定' : agent)}</p>
    </section>
    ${err ? `<section class="cron-drawer-section"><h4>错误信息</h4><p class="cron-drawer-error">${esc(err)}</p></section>` : ''}
  `
  const busy = _runningTaskIds.has(id)
  foot.innerHTML = `
    <div class="cron-drawer-actions">
      <button type="button" class="cron-btn sm primary" data-action="run" data-id="${esc(id)}" ${busy ? 'disabled' : ''}>${busy ? '提交中…' : '立即运行'}</button>
      <button type="button" class="cron-btn sm" data-action="edit" data-id="${esc(id)}">编辑</button>
    </div>`
}

function closeRuleDrawer() {
  _drawerTaskId = null
  const root = q('#cronDrawer')
  if (root) root.hidden = true
}

// ══════════════════════════════════════
//  创建 / 编辑 Modal（自包含事件）
// ══════════════════════════════════════

let _modalRoot = null
let _editingId = null
let _scheduleCtrl = null

async function openWorkspaceDirectoryPicker() {
  try {
    if (!(window.__TAURI__)) {
      toast('当前为 Web 模式，请手动输入工作目录', 'warn')
      return
    }
    const dlg = await import('@tauri-apps/plugin-dialog')
    const picked = await dlg.open({
      directory: true,
      multiple: false,
      title: '选择工作目录',
    })
    const selected = Array.isArray(picked) ? picked[0] : picked
    if (!selected) return
    const input = document.getElementById('fWorkspace')
    if (!input) return
    const raw = String(selected).trim()
    if (!raw) return
    try {
      const resolvedInfo = await api.resolveWorkspacePath(raw)
      const resolved = String(resolvedInfo?.resolved || raw).trim()
      if (!resolved) return
      if (resolvedInfo && resolvedInfo.exists === false) {
        toast(`目录不存在：${resolved}`, 'error')
        return
      }
      if (resolvedInfo && resolvedInfo.is_dir === false) {
        toast(`不是文件夹：${resolved}`, 'error')
        return
      }
      input.value = resolved
      return
    } catch {
      input.value = raw
    }
  } catch (err) {
    toast(`打开目录选择失败: ${err.message || err}`, 'error')
  }
}

async function openCreateModal() {
  _editingId = null
  _scheduleCtrl = createSchedulePanel({ schedule: '0 9 * * 1-5', tone: 'task' })
  await showModalForm('新建定时任务')
}

async function openEditModal(id) {
  const task = _tasks.find(t => t.id === id)
  if (!task) { toast('任务不存在', 'error'); return }
  _editingId = id
  const schedStr = (task.schedule && typeof task.schedule === 'string') ? task.schedule.trim() : ''
  _scheduleCtrl = createSchedulePanel({
    schedule: schedStr,
    scheduledAt: task.scheduled_at || '',
    scheduleType: task.schedule_type || '',
    tone: 'task',
  })
  await showModalForm('编辑定时任务', task)
}

async function showModalForm(title, existing = null) {
  let pushTargets
  let pushConfigured
  try {
    const d = await api.automationFeishuPushDefault()
    pushTargets = Array.isArray(d?.targets) ? d.targets : []
    pushConfigured = !!(d?.configured || pushTargets.length)
  } catch (_) {
    pushConfigured = false
    pushTargets = []
  }
  const pushChecked = pushConfigured && (existing ? !!existing.feishu_push_enabled : true)
  const pushDisabledAttr = pushConfigured ? '' : ' disabled'
  const existingPushKey = pushTargetKey(existing?.push_channel, existing?.push_target_id)
  const selectedPushKey = existingPushKey || pickDefaultPushTargetKey(pushTargets)
  const pushOptionsHtml = pushTargets.map((t) => {
    const active = t.id === selectedPushKey
    return `<button type="button" class="cron-push-option${active ? ' cron-push-option--active' : ''}" data-push-id="${esc(t.id)}" role="radio" aria-checked="${active ? 'true' : 'false'}"><span class="cron-push-option-indicator" aria-hidden="true"></span><span class="cron-push-option-label">${esc(t.label)}</span></button>`
  }).join('')
  const pushSelectHtml = pushTargets.length
    ? `<div class="cron-push-options" id="fPushTargetGroup" role="radiogroup" aria-label="推送渠道"><input type="hidden" id="fPushTargetValue" value="${esc(selectedPushKey)}" />${pushOptionsHtml}</div>`
    : '<div class="cron-field-hint" style="font-size:12px;color:var(--text-secondary,#64748b);">暂无可用的推送渠道</div>'

  const name = existing?.name || '', prompt = existing?.prompt || ''
  const workspace = existing?.workspace || '', maxDur = existing?.max_duration_minutes || 30
  const isOnce = existing?.schedule_type === 'once'
  const schedAt = existing?.scheduled_at || ''
  const existingAgentCode = existing?.agent_code || ''
  const existingModelName = existing?.model_name || ''
  const existingAppId = String(existing?.app_id || '').trim()
  const existingAppParams = (existing?.app_parameters && typeof existing.app_parameters === 'object')
    ? existing.app_parameters
    : {}
  const execKind = existingAppId ? 'workflow' : 'prompt'

  // 加载智能体列表和模型列表
  let agents
  let models
  let publishedApps = []
  try {
    agents = (await api.listAgents()) || []
  } catch (_) { agents = [] }
  try {
    const modelsData = await api.listModels()
    models = Array.isArray(modelsData) ? modelsData : (modelsData?.models || [])
  } catch (_) { models = [] }
  try {
    publishedApps = await api.listApps({ status: 'published', limit: 200 })
    if (!Array.isArray(publishedApps)) publishedApps = []
  } catch (_) { publishedApps = [] }

  const appOptions = [
    `<option value="">选择已发布工作流…</option>`,
    ...publishedApps.map((a) => {
      const id = String(a.id || a.app_id || '')
      const selected = id && id === existingAppId ? ' selected' : ''
      return `<option value="${esc(id)}"${selected}>${esc(a.name || id)}</option>`
    }),
  ].join('')

  _modalRoot = document.createElement('div')
  _modalRoot.className = 'cron-modal-overlay'
  _modalRoot.innerHTML = `
    <div class="cron-modal cron-modal--hub">
      <div class="cron-modal-header">
        <h2 class="cron-modal-title">${esc(title)}</h2>
        <button class="cron-modal-close" id="modalCloseBtn">\u2715</button>
      </div>
      <div class="cron-modal-layout">
        <div class="cron-modal-panels">
          <section class="cron-form-section">
            <h3 class="cron-form-section-title">基本信息</h3>
            <div class="cron-form-group">
              <label class="cron-label">\u4EFB\u52A1\u540D\u79F0 *</label>
              <input class="cron-input" id="fName" value="${esc(name)}" placeholder="\u4F8B\uFF1A\u6BCF\u65E5\u5065\u5EB7\u68C0\u67E5" />
            </div>
            <div class="cron-form-group">
              <label class="cron-label">执行内容 *</label>
              <div class="cron-exec-kind" role="tablist" aria-label="执行类型">
                <button type="button" class="cron-exec-kind__btn${execKind === 'prompt' ? ' is-active' : ''}" data-exec-kind="prompt">提示词</button>
                <button type="button" class="cron-exec-kind__btn${execKind === 'workflow' ? ' is-active' : ''}" data-exec-kind="workflow">已发布工作流</button>
              </div>
              <p class="cron-field-hint" style="font-size:12px;color:var(--text-tertiary);margin:6px 0 0;">工作流到点会走任务中心 DAG（task 工具）；提示词则开一张无人值守任务再规划执行。</p>
            </div>
            <div class="cron-form-group" id="fPromptGroup" ${execKind === 'workflow' ? 'hidden' : ''}>
              <label class="cron-label">\u4EFB\u52A1\u63CF\u8FF0 (Prompt) *</label>
              <textarea class="cron-textarea cron-textarea--large" id="fPrompt" placeholder="\u63CF\u8FF0\u6BCF\u6B21\u6267\u884C\u65F6\u9700\u8981\u505A\u4EC0\u4E48...">${esc(prompt)}</textarea>
            </div>
            <div class="cron-form-group" id="fWorkflowGroup" ${execKind === 'prompt' ? 'hidden' : ''}>
              <label class="cron-label">工作流 *</label>
              <select class="cron-input" id="fAppId">${appOptions}</select>
              <div id="fAppParams" class="cron-app-params" style="margin-top:10px;"></div>
              ${publishedApps.length ? '' : '<div class="cron-field-hint" style="margin-top:8px;font-size:12px;color:var(--warning,#b45309);">暂无已发布工作流。请先到「工作流」发布后再绑定。</div>'}
            </div>
          </section>

          <section class="cron-form-section">
            <h3 class="cron-form-section-title">调度配置</h3>
            <div class="cron-form-group" style="margin-bottom:0;">
              <div id="scheduleContainer">${_scheduleCtrl.html}</div>
            </div>
          </section>

          <section class="cron-form-section" id="fAdvancedSection">
            <h3 class="cron-form-section-title">高级设置</h3>
            <div id="fPromptAdvanced" ${execKind === 'workflow' ? 'hidden' : ''}>
              <div class="cron-form-row" id="cronSelectsRoot"></div>
              <div class="cron-form-group">
                <label class="cron-label">\u5DE5\u4F5C\u76EE\u5F55</label>
                <div class="cron-input-with-action">
                  <input class="cron-input" id="fWorkspace" value="${esc(workspace)}" placeholder="\u53EF\u9009\uFF0C\u5982\uFF1AD:\\work\\project" />
                  <button class="cron-btn sm" id="fWorkspacePickBtn" type="button">\u9009\u62E9\u6587\u4EF6\u5939</button>
                </div>
              </div>
              <div class="cron-form-group">
                <label class="cron-label">\u8BB0\u5FC6</label>
                <label class="cron-check-row" style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
                  <input type="checkbox" id="fMemoryEnabled" ${existing && existing.memory_enabled === true ? 'checked' : ''} />
                  <span>\u542F\u7528</span>
                </label>
              </div>
            </div>
            <div class="cron-form-group">
              <label class="cron-label">\u4EFB\u52A1\u8D85\u65F6\u65F6\u95F4\uFF08\u5206\u949F\uFF09</label>
              <input class="cron-input" id="fMaxDuration" type="number" value="${maxDur}" min="1" max="1440" />
            </div>
            <div class="cron-form-group">
              <label class="cron-check-row" style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
                <input type="checkbox" id="fPushEnabled"${pushChecked ? ' checked' : ''}${pushDisabledAttr} />
                <span>完成后推送结果</span>
              </label>
            </div>
            <div class="cron-form-group">
              <label class="cron-label">推送渠道</label>
              ${pushSelectHtml}
            </div>
          </section>
        </div>
      </div>
      <div class="cron-modal-footer">
        <button class="cron-btn" id="modalCancelBtn">\u53D6\u6D88</button>
        <button class="cron-btn primary" id="modalSaveBtn">${existing ? '\u4FDD\u5B58\u4FEE\u6539' : '\u521B\u5EFA\u4EFB\u52A1'}</button>
      </div>
    </div>
  `

  document.body.appendChild(_modalRoot)

  const pushEnabledEl = _modalRoot.querySelector('#fPushEnabled')
  const pushTargetGroup = _modalRoot.querySelector('#fPushTargetGroup')
  const pushTargetValueEl = _modalRoot.querySelector('#fPushTargetValue')
  if (pushEnabledEl && pushTargetGroup) {
    const syncPushOptions = () => {
      const disabled = !pushEnabledEl.checked
      pushTargetGroup.classList.toggle('is-disabled', disabled)
      pushTargetGroup.querySelectorAll('.cron-push-option').forEach((btn) => {
        btn.disabled = disabled
      })
    }
    pushTargetGroup.querySelectorAll('.cron-push-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (pushEnabledEl.disabled || btn.disabled) return
        const nextId = btn.dataset.pushId || ''
        if (!nextId || !pushTargetValueEl) return
        pushTargetValueEl.value = nextId
        pushTargetGroup.querySelectorAll('.cron-push-option').forEach((item) => {
          const active = item === btn
          item.classList.toggle('cron-push-option--active', active)
          item.setAttribute('aria-checked', active ? 'true' : 'false')
        })
      })
    })
    pushEnabledEl.addEventListener('change', syncPushOptions)
    syncPushOptions()
  }

  // 自包含事件绑定 —— 不依赖页面委托！
  _scheduleCtrl.initEvents(_modalRoot)

  // 关闭按钮
  _modalRoot.querySelector('#modalCloseBtn').onclick = () => closeModals()
  _modalRoot.querySelector('#modalCancelBtn').onclick = () => closeModals()
  const workspacePickBtn = _modalRoot.querySelector('#fWorkspacePickBtn')
  if (workspacePickBtn) workspacePickBtn.onclick = async () => { await openWorkspaceDirectoryPicker() }

  // 保存按钮
  _modalRoot.querySelector('#modalSaveBtn').onclick = async () => await saveFromForm()

  // 点击遮罩关闭
  _modalRoot.addEventListener('click', e => {
    if (e.target === _modalRoot) closeModals()
  })

  // 挂载 React 下拉组件（Radix Select，固定 side=bottom）
  const selectsRoot = _modalRoot.querySelector('#cronSelectsRoot')
  if (selectsRoot) {
    mountCronSelects(selectsRoot, {
      agents: agents.map(a => ({
        code: a.agent_code || a.code || '',
        name: a.name || a.agent_name || '',
      })),
      models,
      initialAgentCode: existingAgentCode,
      initialModelName: existingModelName,
    })
  }

  const setExecKind = (kind) => {
    const isWorkflow = kind === 'workflow'
    _modalRoot.querySelectorAll('[data-exec-kind]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.execKind === kind)
    })
    const promptGroup = _modalRoot.querySelector('#fPromptGroup')
    const workflowGroup = _modalRoot.querySelector('#fWorkflowGroup')
    const promptAdvanced = _modalRoot.querySelector('#fPromptAdvanced')
    if (promptGroup) promptGroup.hidden = isWorkflow
    if (workflowGroup) workflowGroup.hidden = !isWorkflow
    if (promptAdvanced) promptAdvanced.hidden = isWorkflow
  }
  _modalRoot.querySelectorAll('[data-exec-kind]').forEach((btn) => {
    btn.addEventListener('click', () => setExecKind(btn.dataset.execKind || 'prompt'))
  })

  const renderAppParamFields = (paramsSchema, values) => {
    const box = _modalRoot.querySelector('#fAppParams')
    if (!box) return
    const list = Array.isArray(paramsSchema) ? paramsSchema : []
    if (!list.length) {
      box.innerHTML = '<div class="cron-field-hint" style="font-size:12px;color:var(--text-tertiary);">该工作流无需参数</div>'
      return
    }
    const vals = values && typeof values === 'object' ? values : {}
    box.innerHTML = list
      .map((p) => {
        const key = String(p?.name || p?.key || '').trim()
        if (!key) return ''
        const label = String(p?.label || p?.title || key)
        const required = p?.required ? ' *' : ''
        const def = vals[key] != null ? vals[key] : (p?.default ?? p?.default_value ?? '')
        return `<div class="cron-form-group cron-app-param">
          <label class="cron-label">${esc(label)}${required}</label>
          <input class="cron-input" data-app-param="${esc(key)}" value="${esc(def)}" placeholder="${esc(p?.placeholder || '')}" />
        </div>`
      })
      .join('')
  }

  const loadAppParamsForSelect = async (appId, presetValues) => {
    const id = String(appId || '').trim()
    const box = _modalRoot.querySelector('#fAppParams')
    if (!box) return
    if (!id) {
      box.innerHTML = ''
      return
    }
    box.innerHTML = '<div class="cron-field-hint" style="font-size:12px;">加载参数…</div>'
    try {
      const app = await api.getApp(id)
      renderAppParamFields(app?.parameters || [], presetValues)
    } catch (e) {
      box.innerHTML = `<div class="cron-field-hint" style="font-size:12px;color:var(--error);">加载失败：${esc(String(e?.message || e))}</div>`
    }
  }

  const appSelect = _modalRoot.querySelector('#fAppId')
  if (appSelect) {
    appSelect.addEventListener('change', () => {
      void loadAppParamsForSelect(appSelect.value, {})
    })
    if (existingAppId) {
      void loadAppParamsForSelect(existingAppId, existingAppParams)
    }
  }

  // ESC 关闭
  const escHandler = (e) => { if (e.key === 'Escape') { closeModals(); document.removeEventListener('keydown', escHandler) } }
  document.addEventListener('keydown', escHandler)
}

async function saveFromForm() {
  const name = document.getElementById('fName').value.trim()
  if (!name) { toast('请输入任务名称', 'warn'); return }

  const execKindBtn = document.querySelector('.cron-exec-kind__btn.is-active')
  const execKind = execKindBtn?.dataset?.execKind === 'workflow' ? 'workflow' : 'prompt'
  const prompt = (document.getElementById('fPrompt')?.value || '').trim()
  const appId = (document.getElementById('fAppId')?.value || '').trim()
  const appParameters = {}
  document.querySelectorAll('[data-app-param]').forEach((el) => {
    const key = el.getAttribute('data-app-param')
    if (!key) return
    appParameters[key] = String(el.value || '')
  })

  if (execKind === 'workflow') {
    if (!appId) { toast('请选择已发布工作流', 'warn'); return }
  } else if (!prompt) {
    toast('请输入任务描述', 'warn')
    return
  }

  const workspace = document.getElementById('fWorkspace')?.value?.trim() || null
  const maxDuration = parseInt(document.getElementById('fMaxDuration')?.value, 10) || 30
  const sched = _scheduleCtrl.getSchedule()
  console.log('[cron] getSchedule result:', JSON.stringify(sched))

  let pushConfiguredSave
  let pushTargetsSave
  try {
    const d = await api.automationFeishuPushDefault()
    pushTargetsSave = Array.isArray(d?.targets) ? d.targets : []
    pushConfiguredSave = !!(d?.configured || pushTargetsSave.length)
  } catch (_) {
    pushConfiguredSave = false
    pushTargetsSave = []
  }

  const pushEnabledEl = document.getElementById('fPushEnabled')
  const pushTargetValueEl = document.getElementById('fPushTargetValue')
  const pushEnabled = pushConfiguredSave && !!(pushEnabledEl && pushEnabledEl.checked)
  let pushChannel = ''
  let pushTargetId = ''
  if (pushEnabled && pushTargetValueEl) {
    const parsed = parsePushTargetKey(pushTargetValueEl.value)
    pushChannel = parsed.channel
    pushTargetId = parsed.targetId
  }
  if (pushEnabled && (!pushChannel || !pushTargetId)) {
    const fallbackKey = pickDefaultPushTargetKey(pushTargetsSave)
    const parsed = parsePushTargetKey(fallbackKey)
    pushChannel = parsed.channel
    pushTargetId = parsed.targetId
  }
  const memoryEl = document.getElementById('fMemoryEnabled')
  const agentCodeEl = document.getElementById('fAgentCode')
  const modelNameEl = document.getElementById('fModelName')
  var apiData = {
    id: _editingId || undefined,
    name: name,
    prompt: execKind === 'workflow' ? (prompt || `运行工作流 ${appId}`) : prompt,
    workspace: workspace,
    max_duration_minutes: maxDuration,
    schedule_type: (sched.freq === 'once') ? 'once' : 'recurring',
    rrule: sched.rrule || '',
    schedule: sched.cronExpr || '',
    days: sched.days || undefined,
    feishu_push_enabled: pushEnabled,
    push_channel: pushEnabled ? pushChannel : '',
    push_target_id: pushEnabled ? pushTargetId : '',
    langgraph_run: true,
    memory_enabled: !!(memoryEl && memoryEl.checked),
    agent_code: (agentCodeEl && agentCodeEl.value) || '',
    model_name: (modelNameEl && modelNameEl.value) || '',
    app_id: execKind === 'workflow' ? appId : '',
    app_parameters: execKind === 'workflow' ? appParameters : {},
  }
  // 一次性模式用 scheduled_at 字段；非一次性必须清空，防止旧值残留
  if (sched.freq === 'once' && sched.scheduledAt) {
    apiData.scheduled_at = sched.scheduledAt
  } else {
    apiData.scheduled_at = null
  }

  console.log('[cron] sending apiData:', JSON.stringify({
    id: apiData.id,
    name: apiData.name,
    schedule_type: apiData.schedule_type,
    schedule: apiData.schedule,
    scheduled_at: apiData.scheduled_at,
    app_id: apiData.app_id,
  }))

  try {
    if (_editingId) {
      const updateRes = await api.automationUpdate(apiData)
      console.log('[cron] automationUpdate response:', JSON.stringify(updateRes))
      toast('已更新', 'success')
    } else {
      const createRes = await api.automationCreate(apiData)
      console.log('[cron] automationCreate response:', JSON.stringify(createRes))
      toast('创建成功', 'success')
    }
    closeModals(); await refresh()
  } catch (err) { toast(`保存失败: ${err.message}`, 'error') }
}

function closeModals() {
  unmountCronSelects()
  if (_modalRoot) { _modalRoot.remove(); _modalRoot = null; _scheduleCtrl = null }
}


// ══════════════════════════════════════
//  History Panel（自包含事件）
// ══════════════════════════════════════

let _historyRoot = null

function openRunDetail(runId) {
  const run = _runsRowCache[String(runId || '').trim()]
  if (!run) {
    toast('找不到该次运行', 'error')
    return
  }
  closeRunDetail()
  const st = normalizeRunStatus(run.status)
  const summary = String(run.summary || run.output || '').trim()
  const err = String(run.error || '').trim()
  const diag = String(run.diag || '').trim()
  const collabId = String(run.collabTaskId || '').trim()
  const chatBtn =
    run.sessionKey && run.threadId
      ? `<button type="button" class="cron-btn ghost" data-open-chat="${esc(run.sessionKey)}" data-open-thread="${esc(run.threadId)}">在聊天中打开</button>`
      : ''
  const taskBtn = collabId
    ? `<button type="button" class="cron-btn primary" data-open-task="${esc(collabId)}">打开任务</button>`
    : ''
  _historyRoot = document.createElement('div')
  _historyRoot.className = 'cron-history-overlay'
  _historyRoot.innerHTML = `
    <div class="cron-history-panel cron-run-detail-panel">
      <div class="cron-modal-header">
        <div>
          <h2 class="cron-modal-title">运行详情</h2>
          <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px;">${esc(run.name)} · ${esc(run.time)}</div>
        </div>
        <button class="cron-modal-close" id="histCloseBtn" type="button" aria-label="关闭">✕</button>
      </div>
      <div class="cron-history-list">
        <div class="cron-history-item">
          <span class="cron-history-status ${st === 'success' ? 'ok' : st === 'running' || st === 'queued' ? 'timeout' : 'fail'}"></span>
          <div class="cron-history-body">
            <div class="cron-history-item__head">
              <span class="cron-run-status cron-run-status--${esc(st)}">${esc(formatRunStatusZh(run.status))}</span>
              <span class="cron-history-time">${esc(formatTriggerZh(run.triggerType))} · ${esc(run.duration ? formatDurationSec(run.duration) : '—')}</span>
            </div>
            ${summary
              ? `<div class="cron-history-summary">${esc(summary)}</div>`
              : err
                ? `<div class="cron-history-summary cron-history-summary--err">${esc(err)}</div>`
                : `<div class="cron-history-summary cron-history-summary--muted">暂无摘要</div>`}
            ${err && summary ? `<div class="cron-history-error">错误：${esc(err)}</div>` : ''}
            <div class="cron-history-meta">
              自动化：${esc(run.name)}
              ${collabId ? ` · 任务中心：<code>${esc(collabId)}</code>` : ''}
              ${run.appId ? ` · 工作流：<code>${esc(run.appId)}</code>` : ''}
              ${run.runId ? ` · run：<code>${esc(run.runId)}</code>` : ''}
            </div>
            ${diag ? `<details class="cron-history-diag"><summary>技术详情</summary><pre>${esc(diag)}</pre></details>` : ''}
            <div class="cron-history-actions">${taskBtn}${chatBtn}</div>
          </div>
        </div>
      </div>
    </div>`
  document.body.appendChild(_historyRoot)
  _historyRoot.querySelector('#histCloseBtn').onclick = () => closeRunDetail()
  _historyRoot.addEventListener('click', (e) => {
    if (e.target === _historyRoot) closeRunDetail()
    const chatBtnEl = e.target?.closest?.('[data-open-chat]')
    if (chatBtnEl) {
      openAutomationChat(
        chatBtnEl.getAttribute('data-open-chat'),
        chatBtnEl.getAttribute('data-open-thread'),
      )
      return
    }
    const taskBtnEl = e.target?.closest?.('[data-open-task]')
    if (taskBtnEl) {
      const tid = String(taskBtnEl.getAttribute('data-open-task') || '').trim()
      if (tid) {
        closeRunDetail()
        window.location.hash = `#/task/${encodeURIComponent(tid)}`
      }
    }
  })
}

function closeRunDetail() {
  if (_historyRoot) {
    _historyRoot.remove()
    _historyRoot = null
  }
}

function closeHistory() {
  closeRunDetail()
}

function openAutomationChat(sessionKey, threadId) {
  const sk = String(sessionKey || '').trim()
  const tid = String(threadId || '').trim()
  if (!sk || !tid) {
    toast('该次执行尚未关联聊天会话', 'warning')
    return
  }
  // Unhide so the session appears in the main list and can continue as a normal chat.
  void api.chatSessionSetHidden(sk, false).catch(() => {})
  sessionStorage.setItem('evopanel_pending_shell_session', sk)
  sessionStorage.setItem('evopanel_pending_shell_thread', tid)
  sessionStorage.removeItem('evopanel_pending_shell_task_id')
  closeHistory()
  window.location.hash = '#/chat'
}
