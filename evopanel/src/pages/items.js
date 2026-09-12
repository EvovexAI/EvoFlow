/**
 * 用户事项 — 任务中心内「我的事项」卡片列表（SaaS 风格）
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showModal, showConfirm } from '../components/modal.js'
import { navigate } from '../router.js'
import './items.css'

const STATUS_COLS = [
  { id: 'todo', label: '待办' },
  { id: 'in_progress', label: '进行中' },
  { id: 'waiting', label: '处理中' },
  { id: 'done', label: '已完成' },
  { id: 'parked', label: '已搁置' },
]

const STATUS_HINT = {
  todo: '还没开始或先记着',
  in_progress: '你自己正在推进',
  waiting: '已派给别人，对方在处理',
  done: '这件事收尾了',
  parked: '暂时不做，以后再说',
}

const PRIORITY_LABEL = {
  none: '无优先级',
  low: '低优先级',
  normal: '中优先级',
  high: '高优先级',
  urgent: '紧急',
}

const TAG_TONES = ['violet', 'blue', 'amber', 'rose', 'slate', 'emerald']

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function todayIso() {
  const d = new Date()
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

function dueMeta(due) {
  const raw = String(due || '').trim()
  if (!raw) return { text: '—', cls: '', hint: '' }
  const day = raw.slice(0, 10)
  const today = todayIso()
  if (day < today) return { text: day, cls: 'is-overdue', hint: '已逾期' }
  if (day === today) return { text: day, cls: 'is-today', hint: '今天截止' }
  return { text: day, cls: '', hint: '' }
}

/** 登记时间与截止同一格式：YYYY-MM-DD */
function formatCreatedAt(raw) {
  const s = String(raw || '').trim()
  if (!s) return '—'
  return s.slice(0, 10) || '—'
}

function progressValue(it) {
  const n = Number(it?.progress)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

function statusLabel(st) {
  return STATUS_COLS.find((c) => c.id === st)?.label || st
}

/** 同名 tag 稳定映射到低饱和色系（权重始终低于状态 Badge） */
function parseTagsInput(raw) {
  return String(raw || '')
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean)
}

function tagTone(tag) {
  const raw = String(tag || '').trim()
  const known = {
    工作: 'slate',
    报告: 'blue',
    运营: 'violet',
    设计: 'violet',
    商务: 'amber',
    行政: 'slate',
    数据分析: 'blue',
    复盘: 'slate',
    入职: 'emerald',
    紧急: 'rose',
  }
  if (known[raw]) return known[raw]
  let h = 0
  for (let k = 0; k < raw.length; k++) h = (h + raw.charCodeAt(k) * (k + 1)) % 997
  return TAG_TONES[h % TAG_TONES.length]
}

function renderCardActions(it) {
  const st = String(it.status || 'todo')
  const id = String(it.id || '')
  const waiting = st === 'waiting'
  const done = st === 'done'
  const parked = st === 'parked'

  let primary = ''
  let secondary = ''
  if (done) {
    primary = `<button type="button" class="im-act" data-act="view" data-id="${esc(id)}">查看</button>`
    secondary = `<button type="button" class="im-act" data-act="restore" data-id="${esc(id)}">恢复</button>`
  } else if (parked) {
    primary = `<button type="button" class="im-act" data-act="edit" data-id="${esc(id)}">编辑</button>`
    secondary = `<button type="button" class="im-act" data-act="restore" data-id="${esc(id)}">恢复</button>`
  } else if (waiting) {
    primary = `<button type="button" class="im-act" data-act="edit" data-id="${esc(id)}">编辑</button>`
    secondary = `<button type="button" class="im-act" data-act="nudge" data-id="${esc(id)}">催办</button>`
  } else {
    primary = `<button type="button" class="im-act" data-act="edit" data-id="${esc(id)}">编辑</button>`
    secondary = `<button type="button" class="im-act" data-act="dispatch" data-id="${esc(id)}">派发</button>`
  }

  let menu = ''
  if (done) {
    menu = `
      <button type="button" role="menuitem" data-act="restore" data-id="${esc(id)}">恢复任务</button>
      <button type="button" role="menuitem" data-act="copy" data-id="${esc(id)}">复制任务</button>
      <div class="im-more-sep" role="separator"></div>
      <button type="button" role="menuitem" data-act="delete" data-id="${esc(id)}" class="is-danger">删除任务</button>`
  } else if (parked) {
    menu = `
      <button type="button" role="menuitem" data-act="done" data-id="${esc(id)}">完成任务</button>
      <button type="button" role="menuitem" data-act="restore" data-id="${esc(id)}">恢复任务</button>
      <button type="button" role="menuitem" data-act="copy" data-id="${esc(id)}">复制任务</button>
      <div class="im-more-sep" role="separator"></div>
      <button type="button" role="menuitem" data-act="delete" data-id="${esc(id)}" class="is-danger">删除任务</button>`
  } else {
    menu = `
      <button type="button" role="menuitem" data-act="done" data-id="${esc(id)}">完成任务</button>
      ${
        waiting
          ? `<button type="button" role="menuitem" data-act="nudge" data-id="${esc(id)}">催办</button>`
          : `<button type="button" role="menuitem" data-act="dispatch" data-id="${esc(id)}">派发</button>`
      }
      <button type="button" role="menuitem" data-act="park" data-id="${esc(id)}">搁置</button>
      <button type="button" role="menuitem" data-act="copy" data-id="${esc(id)}">复制任务</button>
      <div class="im-more-sep" role="separator"></div>
      <button type="button" role="menuitem" data-act="delete" data-id="${esc(id)}" class="is-danger">删除任务</button>`
  }

  return `
    <div class="im-card-actions" data-stop>
      ${primary}
      ${secondary}
      <div class="im-more">
        <button type="button" class="im-act im-act--more" data-act="toggle-more" data-id="${esc(id)}" aria-label="更多操作" aria-haspopup="menu" title="更多">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg>
        </button>
        <div class="im-more-menu" data-more-menu="${esc(id)}" hidden role="menu">${menu}</div>
      </div>
    </div>`
}

async function loadRoles() {
  try {
    const res = await api.proactiveListRoles?.('active')
    const roles = res?.roles || res?.items || (Array.isArray(res) ? res : [])
    return (roles || []).filter((r) => String(r.agent_code || '') !== 'xiaomi')
  } catch {
    return []
  }
}

function roleOptions(roles) {
  return [
    { value: '', label: '自己跟进（不派发）' },
    ...roles.map((r) => ({
      value: String(r.agent_code || ''),
      label: String(r.role_name || r.agent_code || ''),
    })),
  ]
}

function emptyFacets() {
  return { all: 0, todo: 0, in_progress: 0, waiting: 0, urgent: 0, done: 0, parked: 0 }
}

function computeFacets(items) {
  const f = emptyFacets()
  for (const it of items || []) {
    f.all += 1
    const st = String(it.status || 'todo')
    if (st in f) f[st] += 1
    if (String(it.priority || '') === 'urgent') f.urgent += 1
  }
  return f
}

function renderStatusBadge(st) {
  const key = String(st || 'todo')
  return `<span class="im-badge im-badge--status im-badge--st-${esc(key)}" title="${esc(STATUS_HINT[key] || '')}">${esc(statusLabel(key))}</span>`
}

function renderPriorityBadge(pri) {
  const key = String(pri || 'normal')
  return `<span class="im-badge im-badge--priority im-badge--pri-${esc(key)}">${esc(PRIORITY_LABEL[key] || key)}</span>`
}

function renderTags(tags) {
  const list = Array.isArray(tags) ? tags.filter(Boolean).slice(0, 5) : []
  if (!list.length) return ''
  return `<div class="im-card-tags">${list
    .map((t) => `<span class="im-tag im-tag--${tagTone(t)}">${esc(t)}</span>`)
    .join('')}</div>`
}

function renderProgress(pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0))
  return `
    <div class="im-card-meta im-card-meta--progress" title="进度 ${p}%">
      <span class="im-meta-label">进度</span>
      <span class="im-meta-value im-progress-pct">${p}%</span>
      <div class="im-progress-track" aria-hidden="true">
        <div class="im-progress-fill" style="width:${p}%"></div>
      </div>
    </div>`
}

function renderItemCard(it, idx, selected) {
  const st = String(it.status || 'todo')
  const pri = String(it.priority || 'normal')
  const linkedIds = Array.isArray(it.linked_task_ids) ? it.linked_task_ids.filter(Boolean) : []
  const linked = linkedIds.length
  const due = dueMeta(it.due_at)
  const created = formatCreatedAt(it.created_at)
  const pct = progressValue(it)
  const id = String(it.id || '')
  const checked = selected.has(id) ? ' checked' : ''
  const linkLabel = linked ? `关联：${linked} 个任务` : ''
  const doneCls = st === 'done' ? ' is-done' : ''
  const selCls = selected.has(id) ? ' is-selected' : ''
  return `
    <article class="im-card${doneCls}${selCls}" data-item-id="${esc(id)}" data-act="open-card" tabindex="0">
      <div class="im-card-check" data-stop>
        <input type="checkbox" class="im-check" data-act="toggle-select" data-id="${esc(id)}"${checked} aria-label="选择事项" />
      </div>
      <div class="im-card-no" aria-hidden="true">${idx}</div>
      <div class="im-card-main">
        <div class="im-card-title" title="${esc(it.title || '未命名事项')}">${esc(it.title || '未命名事项')}</div>
        ${
          it.notes
            ? `<div class="im-card-notes" title="${esc(it.notes)}">${esc(it.notes)}</div>`
            : '<div class="im-card-notes im-card-notes--empty">暂无备注</div>'
        }
        ${
          String(it.conclusion || '').trim()
            ? `<div class="im-card-conclusion" title="${esc(it.conclusion)}"><span class="im-card-conclusion-label">结论</span>${esc(it.conclusion)}</div>`
            : ''
        }
        ${renderTags(it.tags)}
      </div>
      <div class="im-card-meta im-card-meta--status">
        ${renderStatusBadge(st)}
        ${renderPriorityBadge(pri)}
      </div>
      ${renderProgress(pct)}
      <div class="im-card-meta im-card-meta--due">
        <div class="im-time-pair">
          <span class="im-meta-label">登记时间</span>
          <span class="im-meta-value">${esc(created)}</span>
        </div>
        <div class="im-time-pair">
          <span class="im-meta-label">截止时间</span>
          <span class="im-meta-value ${due.cls}">${esc(due.text)}</span>
          ${due.hint ? `<span class="im-due-hint ${due.cls}">${esc(due.hint)}</span>` : ''}
        </div>
        ${
          linked
            ? `<button type="button" class="im-link-inline" data-act="open-tasks" data-id="${esc(id)}" data-stop title="打开关联任务">${esc(linkLabel)}</button>`
            : ''
        }
      </div>
      ${renderCardActions(it)}
    </article>`
}

/**
 * @returns {{ refresh: () => Promise<void>, openCreate: () => void, destroy: () => void }}
 */
export function mountItemsPanel(host, { openCreate = false, onSwitchToTasks } = {}) {
  if (!(host instanceof HTMLElement)) {
    throw new Error('mountItemsPanel: host required')
  }

  const root = document.createElement('div')
  root.className = 'items-page items-page--embedded items-page--cards'
  const state = {
    items: [],
    facets: emptyFacets(),
    roles: [],
    /** '' | status id | 'urgent' */
    chip: '',
    statusFilter: '',
    priorityFilter: '',
    tagFilter: '',
    q: '',
    includeDone: true,
    page: 1,
    pageSize: Number(localStorage.getItem('evopanel_items_page_size') || 20) || 20,
    total: 0,
    pages: 1,
    loading: false,
    selected: new Set(),
    filterOpen: false,
    moreOpenId: '',
  }

  root.innerHTML = `
    <div class="im-toolbar-wrap">
      <div class="im-toolbar">
        <div class="im-status-tabs" data-im-chips role="tablist" aria-label="状态筛选"></div>
        <div class="im-toolbar-right">
          <label class="im-search">
            <span class="im-search-ico" aria-hidden="true"></span>
            <input type="search" data-items-q placeholder="搜索任务、备注或标签" aria-label="搜索事项" />
          </label>
          <div class="im-filter-wrap">
            <button type="button" class="im-filter-btn" data-items-filter-toggle aria-expanded="false">
              <span class="im-filter-ico" aria-hidden="true"></span>
              筛选
              <span class="im-filter-dot" data-items-filter-dot hidden></span>
            </button>
            <div class="im-filter-panel" data-items-filter-panel hidden>
              <label class="im-filter-row">
                <span>状态</span>
                <select data-items-filter-status>
                  <option value="">全部</option>
                  ${STATUS_COLS.map((c) => `<option value="${c.id}">${c.label}</option>`).join('')}
                </select>
              </label>
              <label class="im-filter-row">
                <span>优先级</span>
                <select data-items-priority>
                  <option value="">全部</option>
                  ${Object.entries(PRIORITY_LABEL)
                    .map(([v, l]) => `<option value="${v}">${l}</option>`)
                    .join('')}
                </select>
              </label>
              <label class="im-filter-row">
                <span>标签</span>
                <input type="text" data-items-filter-tag placeholder="精确匹配标签" />
              </label>
              <label class="im-filter-row im-filter-row--check">
                <input type="checkbox" data-items-include-done checked />
                <span>列表中包含已完成</span>
              </label>
              <div class="im-filter-actions">
                <button type="button" class="btn btn-sm btn-ghost" data-items-filter-clear>清空</button>
                <button type="button" class="btn btn-sm btn-primary" data-items-filter-apply>查询</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <form class="im-quick-add" data-items-quick-add autocomplete="off">
        <input
          type="text"
          class="im-quick-add-title"
          data-items-quick-title
          placeholder="快速添加事项…"
          aria-label="事项标题"
          maxlength="200"
        />
        <input
          type="text"
          class="im-quick-add-tags"
          data-items-quick-tags
          placeholder="标签（可选，逗号分隔）"
          aria-label="标签（可选）"
          maxlength="120"
        />
        <button type="submit" class="btn btn-sm btn-primary im-quick-add-btn">添加</button>
      </form>
      <div class="im-batch" data-items-batch hidden></div>
    </div>
    <div class="im-list" data-items-body></div>
    <div class="im-pager" data-items-pager hidden></div>
  `
  host.replaceChildren(root)

  function activeChip() {
    if (state.priorityFilter === 'urgent' && !state.statusFilter) return 'urgent'
    if (state.statusFilter) return state.statusFilter
    return ''
  }

  function paintChips() {
    const el = root.querySelector('[data-im-chips]')
    if (!el) return
    const f = state.facets
    const cur = activeChip()
    const chips = [
      { id: '', label: '全部', count: f.all },
      { id: 'todo', label: '待办', count: f.todo },
      { id: 'in_progress', label: '进行中', count: f.in_progress },
      { id: 'waiting', label: '处理中', count: f.waiting },
      { id: 'urgent', label: '紧急', count: f.urgent },
      { id: 'done', label: '已完成', count: f.done },
      { id: 'parked', label: '已搁置', count: f.parked },
    ]
    el.innerHTML = chips
      .map(
        (c) => `
      <button type="button" class="im-chip${cur === c.id ? ' is-active' : ''}" data-chip="${esc(c.id)}" role="tab" aria-selected="${cur === c.id ? 'true' : 'false'}">
        <span class="im-chip-label">${esc(c.label)}</span>
        <span class="im-chip-count">${c.count}</span>
      </button>`,
      )
      .join('')
  }

  function syncFilterDot() {
    const dot = root.querySelector('[data-items-filter-dot]')
    const btn = root.querySelector('[data-items-filter-toggle]')
    if (!dot) return
    const advanced =
      !!state.tagFilter ||
      !state.includeDone ||
      !!(state.priorityFilter && state.priorityFilter !== 'urgent')
    dot.hidden = !advanced
    btn?.classList.toggle('is-active', advanced)
  }

  function syncFilterDraft() {
    const st = root.querySelector('[data-items-filter-status]')
    const pri = root.querySelector('[data-items-priority]')
    const tag = root.querySelector('[data-items-filter-tag]')
    const done = root.querySelector('[data-items-include-done]')
    if (st) st.value = state.statusFilter || ''
    if (pri) pri.value = state.priorityFilter || ''
    if (tag) tag.value = state.tagFilter || ''
    if (done) done.checked = state.includeDone
  }

  function paintBatch() {
    const bar = root.querySelector('[data-items-batch]')
    const wrap = root.querySelector('.im-toolbar-wrap')
    if (!bar) return
    const n = state.selected.size
    if (!n) {
      bar.hidden = true
      bar.innerHTML = ''
      wrap?.classList.remove('is-batching')
      return
    }
    wrap?.classList.add('is-batching')
    bar.hidden = false
    bar.innerHTML = `
      <span class="im-batch-count">已选择 ${n} 项</span>
      <button type="button" class="im-batch-btn" data-batch="done">完成</button>
      <button type="button" class="im-batch-btn" data-batch="dispatch">派发</button>
      <button type="button" class="im-batch-btn" data-batch="park">搁置</button>
      <button type="button" class="im-batch-btn im-batch-btn--danger" data-batch="delete">删除</button>
      <button type="button" class="im-batch-btn im-batch-btn--mute" data-batch="clear">取消选择</button>
    `
  }

  function paintPager() {
    const pager = root.querySelector('[data-items-pager]')
    if (!pager) return
    if (state.total <= 0) {
      pager.hidden = true
      pager.innerHTML = ''
      return
    }
    pager.hidden = false
    pager.innerHTML = `
      <span class="im-pager-meta">共 ${state.total} 条</span>
      <label class="im-pager-size">
        每页
        <select data-items-page-size aria-label="每页条数">
          ${[10, 20, 50, 100].map((n) => `<option value="${n}"${n === state.pageSize ? ' selected' : ''}>${n}</option>`).join('')}
        </select>
      </label>
      <div class="im-pager-nav">
        <button type="button" class="im-page-btn" data-items-page="prev"${state.page <= 1 ? ' disabled' : ''}>上一页</button>
        <span class="im-page-cur">${state.page}</span>
        <button type="button" class="im-page-btn" data-items-page="next"${state.page >= state.pages ? ' disabled' : ''}>下一页</button>
      </div>
    `
    pager.querySelector('[data-items-page-size]')?.addEventListener('change', (e) => {
      state.pageSize = Number(e.target?.value || 20) || 20
      state.page = 1
      try {
        localStorage.setItem('evopanel_items_page_size', String(state.pageSize))
      } catch {
        /* ignore */
      }
      void refresh()
    })
    pager.querySelectorAll('[data-items-page]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dir = btn.getAttribute('data-items-page')
        if (dir === 'prev' && state.page > 1) state.page -= 1
        else if (dir === 'next' && state.page < state.pages) state.page += 1
        else return
        void refresh()
      })
    })
  }

  function paintList() {
    const body = root.querySelector('[data-items-body]')
    if (!body) return
    if (state.loading && !state.items.length) {
      body.innerHTML = `<div class="im-empty">加载中…</div>`
      return
    }
    if (!state.items.length) {
      body.innerHTML = `<div class="im-empty">${
        state.q || state.statusFilter || state.priorityFilter || state.tagFilter
          ? '没有符合筛选的事项'
          : '还没有事项。点「+ 新建事项」记一条。'
      }</div>`
      return
    }
    const base = (state.page - 1) * state.pageSize
    body.innerHTML = `<div class="im-card-list">${state.items
      .map((it, i) => renderItemCard(it, base + i + 1, state.selected))
      .join('')}</div>`
  }

  function paint() {
    paintChips()
    syncFilterDot()
    paintBatch()
    paintList()
    paintPager()
  }

  async function refreshFacets() {
    try {
      const res = await api.listUserItems({ include_done: true, page: 1, page_size: 200 })
      state.facets = computeFacets(res?.items || [])
    } catch {
      state.facets = emptyFacets()
    }
  }

  async function refresh() {
    state.loading = true
    paintList()
    try {
      const includeDone =
        state.statusFilter === 'done' || state.statusFilter === 'parked' ? true : state.includeDone
      const res = await api.listUserItems({
        status: state.statusFilter || undefined,
        priority: state.priorityFilter || undefined,
        tag: state.tagFilter || undefined,
        q: state.q || undefined,
        include_done: includeDone,
        page: state.page,
        page_size: state.pageSize,
      })
      state.items = res?.items || []
      state.total = Number(res?.total || 0)
      state.page = Number(res?.page || state.page) || 1
      state.pages = Number(res?.pages || 1) || 1
      state.pageSize = Number(res?.page_size || state.pageSize) || 20
      const live = new Set(state.items.map((x) => String(x.id)))
      state.selected = new Set([...state.selected].filter((id) => live.has(id)))
    } catch (e) {
      toast(`加载事项失败：${e}`, 'error')
      state.items = []
      state.total = 0
      state.pages = 1
    } finally {
      state.loading = false
      await refreshFacets()
      paint()
    }
  }

  function applyChip(chipId) {
    const id = String(chipId || '')
    state.page = 1
    if (!id) {
      state.statusFilter = ''
      state.priorityFilter = ''
      state.includeDone = true
    } else if (id === 'urgent') {
      state.statusFilter = ''
      state.priorityFilter = 'urgent'
    } else if (id === 'done' || id === 'parked') {
      state.statusFilter = id
      state.priorityFilter = ''
      state.includeDone = true
    } else {
      state.statusFilter = id
      if (state.priorityFilter === 'urgent') state.priorityFilter = ''
    }
    syncFilterDraft()
    void refresh()
  }

  function applyAdvancedFilter() {
    const st = root.querySelector('[data-items-filter-status]')
    const pri = root.querySelector('[data-items-priority]')
    const tag = root.querySelector('[data-items-filter-tag]')
    const done = root.querySelector('[data-items-include-done]')
    state.statusFilter = String(st?.value || '')
    state.priorityFilter = String(pri?.value || '')
    state.tagFilter = String(tag?.value || '').trim()
    state.includeDone = done ? !!done.checked : true
    state.page = 1
    state.filterOpen = false
    const panel = root.querySelector('[data-items-filter-panel]')
    const btn = root.querySelector('[data-items-filter-toggle]')
    if (panel) panel.hidden = true
    if (btn) btn.setAttribute('aria-expanded', 'false')
    void refresh()
  }

  function clearAdvancedFilter() {
    state.statusFilter = ''
    state.priorityFilter = ''
    state.tagFilter = ''
    state.includeDone = true
    state.page = 1
    syncFilterDraft()
    void refresh()
  }

  function closeMoreMenus(exceptId = '') {
    state.moreOpenId = exceptId
    root.querySelectorAll('[data-more-menu]').forEach((m) => {
      const id = m.getAttribute('data-more-menu')
      m.hidden = id !== exceptId
    })
  }

  function showCreateOrEdit(item = null) {
    const isEdit = !!item
    void Promise.resolve(state.roles.length ? state.roles : loadRoles()).then((roles) => {
      state.roles = roles
      showModal({
        title: isEdit ? '编辑事项' : '新建事项',
        width: 720,
        className: 'im-item-modal',
        fields: [
          {
            name: 'title',
            label: '事项',
            value: item?.title || '',
            placeholder: '例如：周五交无线充电测试报告',
          },
          {
            name: 'notes',
            label: '备注（可选）',
            type: 'textarea',
            rows: 5,
            value: item?.notes || '',
            placeholder: '背景、验收标准、链接…',
          },
          {
            name: 'conclusion',
            label: '处理结论（可选）',
            type: 'textarea',
            rows: 5,
            value: item?.conclusion || '',
            placeholder: '完成后如何收口、根因与修复摘要…',
            hint: '建议在标成「完成」时填写，便于事后回看。',
          },
          {
            name: 'status',
            label: '状态',
            type: 'select',
            inline: true,
            value: item?.status || 'todo',
            options: STATUS_COLS.map((c) => ({
              value: c.id,
              label: STATUS_HINT[c.id] ? `${c.label}（${STATUS_HINT[c.id]}）` : c.label,
            })),
          },
          {
            name: 'priority',
            label: '优先级',
            type: 'select',
            inline: true,
            value: item?.priority || 'normal',
            options: Object.entries(PRIORITY_LABEL).map(([value, label]) => ({ value, label })),
          },
          {
            name: 'due_at',
            label: '截止时间（可选）',
            type: 'date',
            inline: true,
            value: item?.due_at ? String(item.due_at).slice(0, 10) : '',
            placeholder: 'YYYY-MM-DD',
          },
          {
            name: 'progress',
            label: '进度（0–100）',
            type: 'number',
            inline: true,
            value: String(progressValue(item ?? { progress: 0 })),
            placeholder: '0',
          },
          {
            name: 'tags',
            label: '标签（可选）',
            value: (item?.tags || []).join(', '),
            placeholder: '工作, 报告',
            hint: '逗号分隔，可不填；用于筛选与卡片展示。',
          },
          {
            name: 'assignee_intent',
            label: '责任意向',
            type: 'select',
            value: item?.assignee_intent || '',
            options: roleOptions(roles),
            hint: '意向不等于已派发；要点「派发」才会生成任务。',
          },
        ],
        onConfirm: async (result) => {
          const title = String(result.title || '').trim()
          if (!title) {
            toast('请输入事项标题', 'error')
            return
          }
          const assignee = String(result.assignee_intent || '').trim()
          const role = roles.find((r) => String(r.agent_code) === assignee)
          const pctRaw = Number(result.progress)
          const progress = Number.isFinite(pctRaw)
            ? Math.max(0, Math.min(100, Math.round(pctRaw)))
            : 0
          const payload = {
            title,
            notes: String(result.notes || '').trim(),
            conclusion: String(result.conclusion || '').trim(),
            status: result.status || 'todo',
            priority: result.priority || 'normal',
            due_at: String(result.due_at || '').trim() || null,
            progress,
            tags: parseTagsInput(result.tags),
            assignee_intent: assignee || null,
            assignee_label: role ? String(role.role_name || assignee) : null,
          }
          try {
            if (isEdit) {
              await api.updateUserItem(item.id, payload)
              toast('已更新', 'success')
            } else {
              await api.createUserItem({ ...payload, source: 'user' })
              toast('事项已登记', 'success')
            }
            await refresh()
          } catch (e) {
            toast(`保存失败：${e}`, 'error')
          }
        },
      })
    })
  }

  function showDispatch(item) {
    void Promise.resolve(state.roles.length ? state.roles : loadRoles()).then((roles) => {
      state.roles = roles
      if (!roles.length) {
        toast('暂无员工可派发，请先雇佣智能体员工', 'warning')
        return
      }
      showModal({
        title: '派发给员工',
        width: 520,
        className: 'im-item-modal im-item-modal--dispatch',
        fields: [
          {
            name: 'agent_code',
            label: '员工',
            type: 'select',
            value: item.assignee_intent || roles[0]?.agent_code || '',
            options: roles.map((r) => ({
              value: String(r.agent_code || ''),
              label: String(r.role_name || r.agent_code || ''),
            })),
          },
          {
            name: 'wake_now',
            label: '立刻叫醒',
            type: 'select',
            value: '1',
            options: [
              { value: '1', label: '是 — 马上推进' },
              { value: '0', label: '否 — 只建任务，等值班' },
            ],
          },
        ],
        onConfirm: async (result) => {
          const code = String(result.agent_code || '').trim()
          if (!code) {
            toast('请选择员工', 'error')
            return
          }
          try {
            const res = await api.dispatchUserItem(item.id, {
              agent_code: code,
              wake_now: String(result.wake_now) === '1',
            })
            const tid = res?.task_id
            toast(tid ? `已派发并关联任务 ${tid}` : '已派发', 'success')
            await refresh()
          } catch (e) {
            toast(`派发失败：${e}`, 'error')
          }
        },
      })
    })
  }

  async function nudgeItem(item) {
    const code = String(item.assignee_intent || '').trim()
    if (!code) {
      toast('还没有责任人，请先派发', 'warning')
      showDispatch(item)
      return
    }
    try {
      await api.dispatchUserItem(item.id, { agent_code: code, wake_now: true })
      toast('已催办，已叫醒对方推进', 'success')
      await refresh()
    } catch (e) {
      toast(`催办失败：${e}`, 'error')
    }
  }

  async function batchUpdate(act) {
    const ids = [...state.selected]
    if (!ids.length) return
    if (act === 'clear') {
      state.selected.clear()
      paint()
      return
    }
    if (act === 'dispatch') {
      if (ids.length !== 1) {
        toast('请选择单条事项再派发', 'warning')
        return
      }
      const item = state.items.find((x) => String(x.id) === ids[0])
      if (item) showDispatch(item)
      return
    }
    if (act === 'delete') {
      const ok = await showConfirm(`删除选中的 ${ids.length} 条事项？关联任务不会删除。`)
      if (!ok) return
    }
    try {
      for (const id of ids) {
        if (act === 'done') await api.updateUserItem(id, { status: 'done', progress: 100 })
        else if (act === 'park') await api.updateUserItem(id, { status: 'parked' })
        else if (act === 'delete') await api.deleteUserItem(id)
      }
      state.selected.clear()
      toast('已更新', 'success')
      await refresh()
    } catch (e) {
      toast(String(e), 'error')
    }
  }

  async function copyItem(item) {
    if (!item) return
    try {
      await api.createUserItem({
        title: String(item.title || '未命名事项'),
        notes: String(item.notes || ''),
        status: 'todo',
        priority: item.priority || 'normal',
        due_at: item.due_at || null,
        tags: Array.isArray(item.tags) ? [...item.tags] : [],
        assignee_intent: null,
        assignee_label: null,
        source: 'user',
      })
      toast('已复制为新事项', 'success')
      await refresh()
    } catch (e) {
      toast(`复制失败：${e}`, 'error')
    }
  }

  const resetPageAndRefresh = () => {
    state.page = 1
    void refresh()
  }

  async function submitQuickAdd(e) {
    e?.preventDefault?.()
    const titleEl = root.querySelector('[data-items-quick-title]')
    const tagsEl = root.querySelector('[data-items-quick-tags]')
    const title = String(titleEl?.value || '').trim()
    if (!title) {
      toast('请输入事项标题', 'error')
      titleEl?.focus()
      return
    }
    const tags = parseTagsInput(tagsEl?.value)
    try {
      await api.createUserItem({
        title,
        tags,
        status: 'todo',
        priority: 'normal',
        source: 'user',
      })
      if (titleEl) titleEl.value = ''
      if (tagsEl) tagsEl.value = ''
      toast('事项已登记', 'success')
      state.page = 1
      await refresh()
      titleEl?.focus()
    } catch (err) {
      toast(`保存失败：${err}`, 'error')
    }
  }

  root.querySelector('[data-items-quick-add]')?.addEventListener('submit', (e) => {
    void submitQuickAdd(e)
  })

  root.querySelector('[data-items-filter-toggle]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    state.filterOpen = !state.filterOpen
    if (state.filterOpen) syncFilterDraft()
    const panel = root.querySelector('[data-items-filter-panel]')
    const btn = root.querySelector('[data-items-filter-toggle]')
    if (panel) panel.hidden = !state.filterOpen
    if (btn) btn.setAttribute('aria-expanded', state.filterOpen ? 'true' : 'false')
  })
  root.querySelector('[data-items-filter-apply]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    applyAdvancedFilter()
  })
  root.querySelector('[data-items-filter-clear]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    clearAdvancedFilter()
  })

  let qTimer = 0
  const applySearch = (raw) => {
    const next = String(raw || '').trim()
    if (next === state.q) return
    state.q = next
    resetPageAndRefresh()
  }
  root.querySelector('[data-items-q]')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      window.clearTimeout(qTimer)
      applySearch(e.target?.value)
    }
  })
  root.querySelector('[data-items-q]')?.addEventListener('input', (e) => {
    window.clearTimeout(qTimer)
    qTimer = window.setTimeout(() => applySearch(e.target?.value), 280)
  })
  root.querySelector('[data-items-q]')?.addEventListener('change', (e) => {
    window.clearTimeout(qTimer)
    applySearch(e.target?.value)
  })

  const onClick = async (e) => {
    const t = e.target
    if (!(t instanceof Element)) return

    const chip = t.closest('[data-chip]')
    if (chip && root.contains(chip)) {
      applyChip(chip.getAttribute('data-chip') || '')
      return
    }

    const batchBtn = t.closest('[data-batch]')
    if (batchBtn && root.contains(batchBtn)) {
      void batchUpdate(batchBtn.getAttribute('data-batch') || '')
      return
    }

    if (!t.closest('.im-filter-wrap') && state.filterOpen) {
      state.filterOpen = false
      const panel = root.querySelector('[data-items-filter-panel]')
      const btn = root.querySelector('[data-items-filter-toggle]')
      if (panel) panel.hidden = true
      if (btn) btn.setAttribute('aria-expanded', 'false')
    }

    const actEl = t.closest('[data-act]')
    if (!actEl || !root.contains(actEl)) {
      if (!t.closest('.im-more')) closeMoreMenus()
      return
    }

    const act = actEl.getAttribute('data-act')
    const id = actEl.getAttribute('data-id') || ''
    const item = state.items.find((x) => String(x.id) === id)

    if (act === 'toggle-select') {
      e.stopPropagation()
      if (actEl instanceof HTMLInputElement && actEl.checked) state.selected.add(id)
      else state.selected.delete(id)
      const card = actEl.closest('.im-card')
      card?.classList.toggle('is-selected', state.selected.has(id))
      paintBatch()
      try {
        const { emitPageActivity } = await import('../lib/page-activity.js')
        emitPageActivity({
          type: actEl instanceof HTMLInputElement && actEl.checked ? 'select_item' : 'deselect_item',
          module: 'items',
          entityId: id,
          label: item?.title || item?.text || id,
        })
      } catch {
        /* ignore */
      }
      return
    }

    if (act === 'toggle-more') {
      e.stopPropagation()
      closeMoreMenus(state.moreOpenId === id ? '' : id)
      return
    }

    if (act === 'open-card') {
      if (t.closest('[data-stop]')) return
      if (item) showCreateOrEdit(item)
      return
    }

    e.stopPropagation()
    closeMoreMenus()

    if ((act === 'edit' || act === 'view') && item) {
      showCreateOrEdit(item)
      return
    }
    if (act === 'dispatch' && item) {
      showDispatch(item)
      return
    }
    if (act === 'nudge' && item) {
      void nudgeItem(item)
      return
    }
    if (act === 'copy' && item) {
      void copyItem(item)
      return
    }
    if (act === 'restore' && item) {
      try {
        await api.updateUserItem(id, { status: 'todo', progress: 0 })
        toast('已恢复为待办', 'success')
        await refresh()
      } catch (err) {
        toast(String(err), 'error')
      }
      return
    }
    if (act === 'done' && item) {
      try {
        await api.updateUserItem(id, { status: 'done', progress: 100 })
        toast('已完成', 'success')
        await refresh()
      } catch (err) {
        toast(String(err), 'error')
      }
      return
    }
    if (act === 'park' && item) {
      try {
        await api.updateUserItem(id, { status: 'parked' })
        toast('已搁置', 'success')
        await refresh()
      } catch (err) {
        toast(String(err), 'error')
      }
      return
    }
    if (act === 'delete' && item) {
      const ok = await showConfirm(`删除事项「${item.title}」？\n关联的任务不会删除。`)
      if (!ok) return
      try {
        await api.deleteUserItem(id)
        toast('已删除', 'success')
        await refresh()
      } catch (err) {
        toast(String(err), 'error')
      }
      return
    }
    if (act === 'open-tasks' && item) {
      const tid = (item.linked_task_ids || [])[0]
      if (tid) navigate(`/task/${encodeURIComponent(tid)}`)
      else if (typeof onSwitchToTasks === 'function') onSwitchToTasks()
      else navigate('/tasks')
    }
  }

  root.addEventListener('click', onClick)
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const card = e.target?.closest?.('.im-card')
    if (!card || !root.contains(card) || e.target !== card) return
    e.preventDefault()
    const id = card.getAttribute('data-item-id') || ''
    const item = state.items.find((x) => String(x.id) === id)
    if (item) showCreateOrEdit(item)
  })

  void loadRoles().then((r) => {
    state.roles = r
  })
  void refresh().then(() => {
    if (openCreate) showCreateOrEdit(null)
  })

  return {
    refresh,
    openCreate: () => showCreateOrEdit(null),
    destroy: () => {
      window.clearTimeout(qTimer)
      root.removeEventListener('click', onClick)
      host.replaceChildren()
    },
  }
}

/** 兼容旧路由：跳进任务中心「我的事项」 */
export async function render() {
  const hash = String(location.hash || '')
  const openNew = /[?&]new=1(?:&|$)/.test(hash)
  try {
    if (openNew) sessionStorage.setItem('evopanel_items_new', '1')
  } catch {
    /* ignore */
  }
  navigate(openNew ? '/tasks?tab=items&new=1' : '/tasks?tab=items')
  const page = document.createElement('div')
  page.className = 'page'
  page.innerHTML = `<div class="im-empty">正在打开任务中心 · 我的事项…</div>`
  return page
}
