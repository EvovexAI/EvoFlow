/**
 * 岗位工作项 · 全员卡片看板
 * 路由：#/proactive/board  ·  #/proactive/board?role=:code&hideDone=1
 */
import { api } from '../lib/tauri-api.js'
import { navigate, getCurrentRoute } from '../router.js'
import { toast } from '../components/toast.js'
import { showConfirm } from '../components/modal.js'
import {
  buildRoleTaskBoards,
  flattenRoleTaskCards,
  tasksFromListResponse,
} from '../lib/proactive-role-tasks.js'
import { formatTaskStatusZh, toUnifiedTaskStatus } from '../lib/task-status-label.js'
import { formatTaskSourceZh } from '../lib/task-source.js'

/**
 * 看板列：待处理 / 进行中 / 待确认 / 已完成
 */
const KANBAN_COLUMNS = [
  { key: 'pending', label: '待处理', tone: 'muted' },
  { key: 'running', label: '进行中', tone: 'primary' },
  { key: 'waiting', label: '待确认', tone: 'warn' },
  { key: 'done', label: '已完成', tone: 'ok' },
]

const HIDE_DONE_KEY = 'evopanel_pro_kanban_hide_done'
const RECENT_DAYS_KEY = 'evopanel_pro_kanban_recent_days'
const VIEW_KEY = 'evopanel_pro_kanban_view'
const DEFAULT_RECENT_DAYS = 7

const RISK_LABEL = {
  low: '低风险',
  medium: '中风险',
  med: '中风险',
  high: '高风险',
  critical: '极高风险',
  urgent: '紧急',
  normal: '',
}

/** @type {null | (() => void)} */
let _pageCleanup = null

function esc(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function previewLine(text, max = 72) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function fmtShortTime(value) {
  if (!value) return '—'
  const t = Date.parse(String(value))
  if (!Number.isFinite(t)) return String(value)
  try {
    return new Date(t).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return String(value)
  }
}

function riskLabel(risk) {
  const k = String(risk || '').toLowerCase()
  if (!k || k === 'normal' || k === 'low') return RISK_LABEL[k] || ''
  return RISK_LABEL[k] || k
}

function readRecentDaysPref() {
  try {
    const v = localStorage.getItem(RECENT_DAYS_KEY)
    if (v === '0' || v === 'all') return 0
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return Math.min(90, Math.floor(n))
  } catch {
    /* ignore */
  }
  return DEFAULT_RECENT_DAYS
}

function readViewPref() {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    if (v === 'list' || v === 'board') return v
  } catch {
    /* ignore */
  }
  return null
}

function parseBoardQuery() {
  const raw = String(getCurrentRoute() || '')
  const [, queryPart = ''] = raw.split('?')
  const params = new URLSearchParams(queryPart)
  const role = String(params.get('role') || '').trim()
  const hideDoneParam = params.get('hideDone')
  let hideDone = false
  if (hideDoneParam === '1' || hideDoneParam === 'true') hideDone = true
  else if (hideDoneParam === '0' || hideDoneParam === 'false') hideDone = false
  else {
    try {
      hideDone = localStorage.getItem(HIDE_DONE_KEY) === '1'
    } catch {
      hideDone = false
    }
  }
  const daysParam = params.get('days')
  let recentDays = readRecentDaysPref()
  if (daysParam === '0' || daysParam === 'all') recentDays = 0
  else if (daysParam != null && String(daysParam).trim() !== '') {
    const n = Number(daysParam)
    if (Number.isFinite(n) && n >= 0) recentDays = Math.min(90, Math.floor(n))
  }
  const viewParam = params.get('view')
  /** @type {'list'|'board'|null} */
  let view = null
  if (viewParam === 'list' || viewParam === 'board') view = viewParam
  else view = readViewPref()
  return { role, hideDone, recentDays, view }
}

function writeBoardQuery({ role, hideDone, recentDays, view }) {
  const parts = []
  if (role) parts.push(`role=${encodeURIComponent(role)}`)
  if (hideDone) parts.push('hideDone=1')
  const days = recentDays == null ? readRecentDaysPref() : recentDays
  if (days > 0) parts.push(`days=${days}`)
  else parts.push('days=all')
  const v = view === 'list' ? 'list' : 'board'
  parts.push(`view=${v}`)
  const q = parts.length ? `?${parts.join('&')}` : ''
  navigate(`/proactive/board${q}`)
}

function cardUpdatedAtMs(card) {
  const raw = card?.updatedAt || card?.updated_at || card?.createdAt || card?.created_at || card?.at || ''
  const t = Date.parse(String(raw || ''))
  return Number.isFinite(t) ? t : 0
}

function filterCardsByRecentDays(cards, recentDays) {
  const days = Number(recentDays) || 0
  if (days <= 0) return cards
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  return cards.filter((c) => {
    const ts = cardUpdatedAtMs(c)
    if (!ts) return true
    const u = toUnifiedTaskStatus(c.status)
    if (u === 'running' || u === 'pending' || u === 'planning' || u === 'queued' || u === 'waiting_confirmation') {
      return true
    }
    return ts >= cutoff
  })
}

/** @returns {'pending'|'running'|'waiting'|'done'|null} */
function kanbanColumnKey(status) {
  const u = toUnifiedTaskStatus(status)
  if (u === 'cancelled') return null
  if (u === 'running') return 'running'
  if (u === 'waiting_confirmation') return 'waiting'
  if (u === 'completed' || u === 'failed') return 'done'
  return 'pending'
}

function humanizeBoardTitle(name, description = '') {
  let t = String(name || '').trim()
  t = t.replace(/^任务\s*[:：]\s*/u, '')
  const isWrapper =
    /请处理以下任务|均为\s*reviewed|请重试执行|执行超时|递归超限/i.test(t) ||
    /^Task_/i.test(t) ||
    /^\d{10}_[0-9a-f]{4}$/i.test(t)
  if (isWrapper) {
    const fromDesc = String(description || '')
      .replace(/Task_[A-Za-z0-9_]+/gi, '')
      .replace(/\b\d{10}_[0-9a-f]{4}\b/gi, '')
      .replace(/^请处理以下任务\s*[:：]?\s*/u, '')
      .replace(/\d+\s*[)）．.]\s*/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    if (fromDesc.length >= 4) t = fromDesc
  }
  t = t
    .replace(/Task_[A-Za-z0-9_]+/gi, '')
    .replace(/\b\d{10}_[0-9a-f]{4}\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!t || t.length < 2) t = '岗位工作'
  return previewLine(t, 64)
}

function cardSummary(item) {
  const handoff = String(item.summary || '').trim()
  if (handoff) return previewLine(handoff, 96)
  return item.description ? previewLine(item.description, 96) : ''
}

function renderCard(item) {
  const title = humanizeBoardTitle(item.name, item.description)
  const desc = cardSummary(item)
  const statusZh = formatTaskStatusZh(item.status)
  const sourceZh = item.sourceZh || formatTaskSourceZh(item.source)
  const risk = riskLabel(item.risk)
  const updated = fmtShortTime(item.updatedAt || item.updated_at)
  const tid = String(item.mainTaskId || '').trim()
  const agentCode = String(item.agentCode || '').trim()
  const tone = toUnifiedTaskStatus(item.status) === 'failed' ? 'pro-kanban-card--fail' : ''
  return `
    <div class="pro-kanban-card-wrap">
      <button type="button" class="pro-kanban-card ${tone}" data-action="open-drawer"
        data-task-id="${esc(tid)}"
        data-agent-code="${esc(agentCode)}"
        title="查看详情">
        <div class="pro-kanban-card-top">
          <span class="pro-kanban-card-status">${esc(statusZh)}</span>
          ${risk ? `<span class="pro-kanban-card-risk">${esc(risk)}</span>` : ''}
        </div>
        <div class="pro-kanban-card-name">${esc(title)}</div>
        ${desc && !title.includes(desc.slice(0, 12)) ? `<div class="pro-kanban-card-desc">${esc(desc)}</div>` : ''}
        <div class="pro-kanban-card-meta">
          ${sourceZh ? `<span>${esc(sourceZh)}</span>` : ''}
          <span>更新 ${esc(updated)}</span>
        </div>
      </button>
      <button type="button" class="pro-kanban-card-del" data-action="delete-task"
        data-task-id="${esc(tid)}" data-task-name="${esc(title)}"
        title="删除此工作项">删除</button>
    </div>`
}

function groupCards(cards) {
  const byGroup = new Map(KANBAN_COLUMNS.map((c) => [c.key, []]))
  for (const item of cards) {
    const col = kanbanColumnKey(item.status)
    if (!col) continue
    byGroup.get(col)?.push(item)
  }
  return byGroup
}

function countNonEmptyColumns(byGroup) {
  let n = 0
  for (const col of KANBAN_COLUMNS) {
    if ((byGroup.get(col.key) || []).length) n += 1
  }
  return n
}

function renderColumns(cards) {
  const byGroup = groupCards(cards)
  const nonEmpty = countNonEmptyColumns(byGroup)
  const sections = KANBAN_COLUMNS.map((col) => {
    const items = byGroup.get(col.key) || []
    if (!items.length) return ''
    return `
      <section class="pro-kanban-col pro-kanban-col--${esc(col.tone)}" data-col="${esc(col.key)}">
        <header class="pro-kanban-col-head">
          <h2 class="pro-kanban-col-title">${esc(col.label)}</h2>
          <span class="pro-kanban-col-count">${items.length}</span>
        </header>
        <div class="pro-kanban-col-body">
          ${items.map(renderCard).join('')}
        </div>
      </section>`
  }).filter(Boolean)

  if (!sections.length) {
    return `<div class="pro-kanban-empty"><p class="pro-empty-title">当前筛选下暂无工作项</p></div>`
  }
  return `<div class="pro-kanban-cols${nonEmpty === 1 ? ' is-single' : ''}">${sections.join('')}</div>`
}

function renderList(cards) {
  if (!cards.length) {
    return `<div class="pro-kanban-empty"><p class="pro-empty-title">当前筛选下暂无工作项</p></div>`
  }
  const rows = cards.map((item) => {
    const title = humanizeBoardTitle(item.name, item.description)
    const desc = cardSummary(item)
    const statusZh = formatTaskStatusZh(item.status)
    const sourceZh = item.sourceZh || formatTaskSourceZh(item.source)
    const risk = riskLabel(item.risk)
    const updated = fmtShortTime(item.updatedAt || item.updated_at)
    const tid = String(item.mainTaskId || '').trim()
    const agentCode = String(item.agentCode || '').trim()
    return `
      <button type="button" class="pro-kanban-listrow" data-action="open-drawer"
        data-task-id="${esc(tid)}" data-agent-code="${esc(agentCode)}">
        <span class="pro-kanban-listrow-title">${esc(title)}</span>
        <span class="pro-meta-chip">${esc(statusZh)}</span>
        ${desc ? `<p class="pro-kanban-listrow-desc">${esc(desc)}</p>` : ''}
        <div class="pro-kanban-listrow-meta">
          ${sourceZh ? `<span>${esc(sourceZh)}</span>` : ''}
          ${risk ? `<span>${esc(risk)}</span>` : ''}
          <span>更新 ${esc(updated)}</span>
        </div>
      </button>`
  })
  return `<div class="pro-kanban-list">${rows.join('')}</div>`
}

function renderToolbar(roles, { role, hideDone, recentDays, view }, totalVisible) {
  const opts = [
    `<option value="">全部员工</option>`,
    ...roles.map((r) => {
      const code = String(r.agent_code || '').trim()
      const name = String(r.role_name || code).trim()
      const sel = code === role ? ' selected' : ''
      return `<option value="${esc(code)}"${sel}>${esc(name)}</option>`
    }),
  ]
  const days = Number(recentDays) || 0
  const v = view === 'list' ? 'list' : 'board'
  return `
    <div class="pro-kanban-toolbar">
      <div class="pro-kanban-viewtabs" role="tablist" aria-label="视图">
        <button type="button" class="pro-kanban-viewtab${v === 'board' ? ' is-active' : ''}" data-act="view" data-view="board">看板</button>
        <button type="button" class="pro-kanban-viewtab${v === 'list' ? ' is-active' : ''}" data-act="view" data-view="list">列表</button>
      </div>
      <label class="pro-kanban-filter">
        <span class="pro-kanban-filter-label">员工</span>
        <select id="pro-kanban-role" class="pro-kanban-select">${opts.join('')}</select>
      </label>
      <label class="pro-kanban-filter">
        <span class="pro-kanban-filter-label">时间</span>
        <select id="pro-kanban-days" class="pro-kanban-select" title="默认近 7 天">
          <option value="7"${days === 7 ? ' selected' : ''}>近 7 天</option>
          <option value="14"${days === 14 ? ' selected' : ''}>近 14 天</option>
          <option value="30"${days === 30 ? ' selected' : ''}>近 30 天</option>
          <option value="0"${days === 0 ? ' selected' : ''}>全部</option>
        </select>
      </label>
      <label class="pro-kanban-check">
        <input type="checkbox" id="pro-kanban-hide-done"${hideDone ? ' checked' : ''} />
        <span>隐藏已完成</span>
      </label>
      <span class="pro-kanban-total">显示 ${totalVisible} 个工作项</span>
      <button type="button" class="btn btn-sm btn-outline" id="pro-kanban-refresh">刷新</button>
    </div>`
}

function openTaskDrawer(page, item, cardsById) {
  const card = item || cardsById.get(String(item?.mainTaskId || ''))
  if (!card) return
  const existing = page.querySelector('.pro-task-drawer-root')
  existing?.remove()
  const title = humanizeBoardTitle(card.name, card.description)
  const desc = cardSummary(card)
  const statusZh = formatTaskStatusZh(card.status)
  const sourceZh = card.sourceZh || formatTaskSourceZh(card.source)
  const risk = riskLabel(card.risk)
  const tid = String(card.mainTaskId || '').trim()
  const agentCode = String(card.agentCode || '').trim()
  const root = document.createElement('div')
  root.className = 'ef-side-drawer-root pro-task-drawer-root'
  root.innerHTML = `
    <div class="ef-side-drawer-mask pro-task-drawer-mask" data-act="close-drawer"></div>
    <aside class="ef-side-drawer pro-task-drawer" role="dialog" aria-label="工作项详情">
      <header class="ef-side-drawer__head pro-task-drawer__head">
        <div class="ef-side-drawer__brand">
          <span class="ef-side-drawer__mark" aria-hidden="true">项</span>
          <div class="ef-side-drawer__heading">
            <h2 class="ef-side-drawer__title">${esc(title)}</h2>
            <div class="ef-side-drawer__meta pro-task-drawer__meta">${esc(statusZh)}${risk ? ` · ${esc(risk)}` : ''}</div>
          </div>
        </div>
        <button type="button" class="ef-side-drawer__close" data-act="close-drawer" aria-label="关闭">×</button>
      </header>
      <div class="ef-side-drawer__body pro-task-drawer__body">
        <section class="ef-side-drawer__section">
          <h4>摘要</h4>
          <p class="ef-side-drawer__hint" style="margin:0;color:var(--ef-d-ink)">${esc(desc || '暂无摘要')}</p>
        </section>
        <div class="ef-side-drawer__grid">
          <div class="ef-side-drawer__chip"><span>来源</span><strong>${esc(sourceZh || '—')}</strong></div>
          <div class="ef-side-drawer__chip"><span>员工</span><strong>${esc(card.roleName || agentCode || '—')}</strong></div>
        </div>
        <p class="ef-side-drawer__hint">更新：${esc(fmtShortTime(card.updatedAt))}</p>
      </div>
      <footer class="ef-side-drawer__foot pro-task-drawer__foot">
        <div class="ef-side-drawer__actions">
          <button type="button" class="btn btn-sm btn-primary" data-act="open-full"
            data-task-id="${esc(tid)}" data-agent-code="${esc(agentCode)}">打开完整详情</button>
          <button type="button" class="btn btn-sm btn-secondary" data-act="close-drawer">关闭</button>
        </div>
      </footer>
    </aside>`
  page.appendChild(root)
  root.addEventListener('click', (e) => {
    const t = e.target
    if (!(t instanceof Element)) return
    if (t.closest('[data-act="close-drawer"]')) {
      root.remove()
      return
    }
    const full = t.closest('[data-act="open-full"]')
    if (full) {
      const id = full.getAttribute('data-task-id') || ''
      const code = full.getAttribute('data-agent-code') || ''
      if (code && id) {
        navigate(`/proactive/${encodeURIComponent(code)}/work/${encodeURIComponent(id)}`)
      }
    }
  })
}

export function cleanup() {
  if (_pageCleanup) {
    try {
      _pageCleanup()
    } catch {
      /* ignore */
    }
    _pageCleanup = null
  }
}

export async function render() {
  cleanup()

  const page = document.createElement('div')
  page.className = 'page proactive-page pro-kanban-page'

  page.innerHTML = `
    <div class="pro-page-nav">
      <button type="button" class="btn btn-ghost btn-sm" data-act="back">← 返回智能体员工</button>
    </div>
    <div class="pro-hero pro-hero--compact">
      <div class="pro-hero-main">
        <p class="pro-hero-kicker">智能体员工 · 工作项</p>
        <h1 class="page-title">工作项看板</h1>
      </div>
    </div>
    <div id="pro-kanban-toolbar-slot"></div>
    <div id="pro-kanban-board" class="pro-kanban-board">
      <div class="pro-loading">加载工作项…</div>
    </div>
  `

  page.querySelector('[data-act="back"]')?.addEventListener('click', () => navigate('/proactive'))

  let unbind = () => {}
  /** @type {Map<string, any>} */
  let cardsById = new Map()

  const paint = async () => {
    const { role, hideDone, recentDays, view: viewPref } = parseBoardQuery()
    const boardEl = page.querySelector('#pro-kanban-board')
    if (boardEl) boardEl.innerHTML = `<div class="pro-loading">加载工作项…</div>`
    unbind()
    unbind = () => {}

    try {
      const [rolesRes, tasksRes] = await Promise.all([
        api.proactiveListRoles().catch(() => ({ roles: [] })),
        api.listAllTasks().catch(() => null),
      ])
      const roles = (rolesRes.roles || []).filter((r) => r.status !== 'archived')
      const tasks = tasksFromListResponse(tasksRes)
      const boards = buildRoleTaskBoards(roles, tasks)
      let cards = flattenRoleTaskCards(boards, roles)
      cards = cards.filter((c) => !c.isSubtask)
      if (role) cards = cards.filter((c) => String(c.agentCode || '') === role)
      cards = filterCardsByRecentDays(cards, recentDays)
      if (hideDone) {
        cards = cards.filter((c) => {
          const u = toUnifiedTaskStatus(c.status)
          return u !== 'completed' && u !== 'failed'
        })
      }

      const byGroup = groupCards(cards)
      const nonEmpty = countNonEmptyColumns(byGroup)
      // 用户显式选过看板/列表则尊重；未选时：单列默认列表，多列默认看板
      let view = viewPref === 'list' || viewPref === 'board' ? viewPref : null
      if (!view) view = nonEmpty === 1 ? 'list' : 'board'

      cardsById = new Map(cards.map((c) => [String(c.mainTaskId || ''), c]))

      const toolbarSlot = page.querySelector('#pro-kanban-toolbar-slot')
      if (toolbarSlot) {
        toolbarSlot.innerHTML = renderToolbar(roles, { role, hideDone, recentDays, view }, cards.length)
        toolbarSlot.querySelector('#pro-kanban-role')?.addEventListener('change', (e) => {
          writeBoardQuery({ role: String(e.target?.value || '').trim(), hideDone, recentDays, view })
        })
        toolbarSlot.querySelector('#pro-kanban-days')?.addEventListener('change', (e) => {
          const nextDays = Number(e.target?.value || 0) || 0
          try {
            localStorage.setItem(RECENT_DAYS_KEY, String(nextDays))
          } catch {
            /* ignore */
          }
          writeBoardQuery({ role, hideDone, recentDays: nextDays, view })
        })
        toolbarSlot.querySelector('#pro-kanban-hide-done')?.addEventListener('change', (e) => {
          const next = Boolean(e.target?.checked)
          try {
            localStorage.setItem(HIDE_DONE_KEY, next ? '1' : '0')
          } catch {
            /* ignore */
          }
          writeBoardQuery({ role, hideDone: next, recentDays, view })
        })
        toolbarSlot.querySelectorAll('[data-act="view"]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const next = btn.getAttribute('data-view') === 'list' ? 'list' : 'board'
            try {
              localStorage.setItem(VIEW_KEY, next)
            } catch {
              /* ignore */
            }
            writeBoardQuery({ role, hideDone, recentDays, view: next })
          })
        })
        toolbarSlot.querySelector('#pro-kanban-refresh')?.addEventListener('click', () => {
          void paint()
        })
      }

      if (boardEl) {
        if (!cards.length) {
          boardEl.innerHTML = `
            <div class="pro-kanban-empty">
              <p class="pro-empty-title">暂无岗位工作项</p>
              <p class="pro-empty-desc">仅显示带岗位戳的任务。派发或员工创建后会出现在此。</p>
            </div>`
        } else {
          boardEl.innerHTML = view === 'list' ? renderList(cards) : renderColumns(cards)
          const onClick = async (e) => {
            const t = e.target
            if (!(t instanceof Element)) return
            const del = t.closest('[data-action="delete-task"]')
            if (del && boardEl.contains(del)) {
              e.preventDefault()
              e.stopPropagation()
              const taskId = String(del.getAttribute('data-task-id') || '').trim()
              const taskName = String(del.getAttribute('data-task-name') || taskId).trim()
              if (!taskId) return
              const ok = await showConfirm(
                `确定删除工作项「${taskName}」？\n\n将永久删除（含子任务），不可恢复。`,
              )
              if (!ok) return
              del.disabled = true
              try {
                await api.deleteTask(taskId)
                toast('已删除', 'success')
                void paint()
              } catch (err) {
                del.disabled = false
                toast(`删除失败: ${err?.message || err}`, 'error')
              }
              return
            }
            const open = t.closest('[data-action="open-drawer"]')
            if (open && boardEl.contains(open)) {
              e.preventDefault()
              const taskId = String(open.getAttribute('data-task-id') || '').trim()
              const card = cardsById.get(taskId)
              if (card) openTaskDrawer(page, card, cardsById)
            }
          }
          boardEl.addEventListener('click', onClick)
          unbind = () => boardEl.removeEventListener('click', onClick)
        }
      }
    } catch (e) {
      if (boardEl) {
        boardEl.innerHTML = `<div class="pro-error">加载失败: ${esc(String(e?.message || e))}</div>`
      }
    }
  }

  await paint()

  _pageCleanup = () => {
    unbind()
    page.querySelector('.pro-task-drawer-root')?.remove()
  }

  return page
}
