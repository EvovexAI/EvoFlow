/**
 * Shared observability dashboard UI (aligned with 任务中心 tasks-monitor patterns).
 */

export const OBS_TIME_RANGE_STORAGE_KEY = 'evopanel_obs_time_range'

export const OBS_TIME_RANGE_OPTIONS = [
  { key: '24h', label: '近24小时', sinceHours: 24, days: 1 },
  { key: '7d', label: '近7天', sinceHours: 168, days: 7 },
  { key: '30d', label: '近30天', sinceHours: 720, days: 30 },
  { key: '90d', label: '近90天', sinceHours: 2160, days: 90 },
  { key: 'all', label: '全部', sinceHours: null, days: null },
]

export function getObsTimeRange() {
  try {
    const saved = localStorage.getItem(OBS_TIME_RANGE_STORAGE_KEY)
    if (saved && OBS_TIME_RANGE_OPTIONS.some((o) => o.key === saved)) return saved
  } catch {
    /* ignore */
  }
  return '7d'
}

export function setObsTimeRange(key) {
  try {
    localStorage.setItem(OBS_TIME_RANGE_STORAGE_KEY, key)
  } catch {
    /* ignore */
  }
}

export function getObsTimeRangeLabel(key = getObsTimeRange()) {
  return OBS_TIME_RANGE_OPTIONS.find((o) => o.key === key)?.label || key
}

export function obsQueryParams(rangeKey = getObsTimeRange()) {
  const opt = OBS_TIME_RANGE_OPTIONS.find((o) => o.key === rangeKey)
  if (!opt || opt.sinceHours == null) return {}
  return { since_hours: String(opt.sinceHours) }
}

export function obsDaysParam(rangeKey = getObsTimeRange()) {
  const opt = OBS_TIME_RANGE_OPTIONS.find((o) => o.key === rangeKey)
  if (!opt || opt.days == null) return { days: '14' }
  return { days: String(Math.min(14, Math.max(1, opt.days))) }
}

export function fmtMs(v) {
  if (v == null || v === '') return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  if (n < 1000) return `${n.toFixed(0)} ms`
  return `${(n / 1000).toFixed(2)} s`
}

export function fmtPct(v) {
  if (v == null || v === '') return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}

export function fmtNum(v) {
  if (v == null || v === '') return '—'
  if (typeof v === 'object') {
    const n = Number(v.total ?? v.count ?? v.value)
    if (Number.isFinite(n)) return n.toLocaleString()
    return '—'
  }
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString()
}

export function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * @param {HTMLElement | null} container
 * @param {(key: string) => void} onChange
 * @param {string} [activeKey]
 */
export function renderObsTimeFilterBar(container, onChange, activeKey = getObsTimeRange()) {
  if (!container) return
  container.innerHTML = `
    <span class="tasks-time-filter-label">时间范围</span>
    <div class="tasks-time-filter-segments" role="tablist" aria-label="观测时间范围">
      ${OBS_TIME_RANGE_OPTIONS.map(
        (o) =>
          `<button type="button" class="tasks-time-filter-btn${o.key === activeKey ? ' is-active' : ''}" data-obs-range="${escHtml(o.key)}" role="tab" aria-selected="${o.key === activeKey}">${escHtml(o.label)}</button>`,
      ).join('')}
    </div>
  `
  container.querySelectorAll('[data-obs-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-obs-range')
      if (!key || key === getObsTimeRange()) return
      setObsTimeRange(key)
      renderObsTimeFilterBar(container, onChange, key)
      onChange(key)
    })
  })
}

/**
 * @param {{ label: string, mainValue: string, stats?: Array<{ value: string, label: string }>, actionHtml?: string }} opts
 */
export function renderObsHero(opts) {
  const stats = opts.stats || []
  return `
    <div class="tasks-monitor-hero obs-monitor-hero">
      <div class="tasks-monitor-hero-main">
        <span class="tasks-monitor-hero-label">${escHtml(opts.label)}</span>
        <div class="tasks-monitor-hero-value">${escHtml(opts.mainValue)}</div>
      </div>
      ${
        stats.length
          ? `<div class="tasks-monitor-hero-stats">
        ${stats
          .map(
            (s) => `
          <div class="tasks-monitor-hero-stat">
            <span class="tasks-monitor-hero-stat-value">${escHtml(s.value)}</span>
            <span class="tasks-monitor-hero-stat-label">${escHtml(s.label)}</span>
          </div>`,
          )
          .join('')}
      </div>`
          : ''
      }
      ${opts.actionHtml || ''}
    </div>
  `
}

/**
 * @param {Array<{ label: string, value: string, meta?: string, tone?: string }>} cards
 */
export function renderObsStatCards(cards) {
  return `<div class="stat-cards obs-stat-cards">
    ${cards
      .map(
        (c) => `
      <div class="stat-card tasks-stat-card tasks-stat-card--${escHtml(c.tone || 'muted')}">
        <div class="stat-card-label">${escHtml(c.label)}</div>
        <div class="stat-card-value">${escHtml(c.value)}</div>
        ${c.meta ? `<div class="stat-card-meta">${c.meta}</div>` : ''}
      </div>`,
      )
      .join('')}
  </div>`
}

/**
 * @param {{ title: string, subtitle?: string, bodyHtml: string }} opts
 */
export function renderObsSectionCard(opts) {
  const subtitle = opts.subtitle
    ? `<span class="obs-section-subtitle">${escHtml(opts.subtitle)}</span>`
    : ''
  return `
    <section class="task-obs-panel obs-section-panel">
      <header class="task-obs-panel-header">
        <h3 class="task-obs-panel-title">${escHtml(opts.title)}${subtitle}</h3>
      </header>
      <div class="task-obs-panel-body obs-section-body">${opts.bodyHtml}</div>
    </section>
  `
}

/** @param {'primary'|'secondary'|'ghost'|'danger'} variant */
export function obsActionBtn(label, variant = 'secondary', extraAttrs = '', extraClass = '') {
  const cls = ['btn', 'btn-sm', `btn-${variant}`, extraClass].filter(Boolean).join(' ')
  return `<button type="button" class="${cls}" ${extraAttrs}>${escHtml(label)}</button>`
}

export function obsStatusTag(status) {
  const raw = String(status ?? '').trim()
  const s = raw.toLowerCase()
  const n = Number(raw)
  let cls = 'tag--subtle'
  if (s === 'success' || s === 'completed') cls = 'tag--completed'
  else if (s === 'error' || s === 'failed') cls = 'tag--failed'
  else if (s === 'pending' || s === 'warning') cls = 'tag--pending'
  else if (Number.isFinite(n)) {
    if (n >= 500) cls = 'tag--failed'
    else if (n >= 400) cls = 'tag--failed'
    else if (n >= 300) cls = 'tag--pending'
    else if (n >= 200) cls = 'tag--completed'
  } else if (s) cls = 'tag--executing'
  return `<span class="tag ${cls}">${escHtml(raw || '—')}</span>`
}

export function renderObsFilterField(label, controlHtml) {
  return `<label class="obs-filter-field"><span class="obs-filter-label">${escHtml(label)}</span>${controlHtml}</label>`
}

export function renderObsFilterForm(fieldsHtml) {
  return `<form class="obs-filter-form">
    <div class="obs-filter-fields">${fieldsHtml}</div>
    <div class="obs-filter-actions">
      <button type="submit" class="btn btn-sm btn-primary">查询</button>
      <button type="button" class="btn btn-sm btn-ghost" data-reset="1">重置</button>
    </div>
  </form>`
}

/**
 * @param {HTMLElement | null} container
 * @param {{ page?: number, pages?: number, total?: number, page_size?: number }} meta
 * @param {(page: number) => void} onPage
 */
export function bindObsPagination(container, meta, onPage) {
  if (!container) return
  const page = meta.page || 1
  const pages = meta.pages || 1
  const total = meta.total || 0
  const pageSize = meta.page_size || 20
  container.innerHTML = `<div class="obs-pagination-bar">
    <span class="obs-pagination-meta">共 <strong>${fmtNum(total)}</strong> 条 · 第 ${page} / ${pages} 页 · 每页 ${pageSize}</span>
    <div class="obs-pagination-actions">
      <button type="button" class="btn btn-sm btn-secondary" data-page="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <button type="button" class="btn btn-sm btn-secondary" data-page="next" ${page >= pages ? 'disabled' : ''}>下一页</button>
    </div>
  </div>`
  container.querySelector('[data-page="prev"]')?.addEventListener('click', () => {
    if (page > 1) onPage(page - 1)
  })
  container.querySelector('[data-page="next"]')?.addEventListener('click', () => {
    if (page < pages) onPage(page + 1)
  })
}

export function renderObsTable(headers, rowsHtml, { emptyColspan, emptyText, wrapPanel = true } = {}) {
  const colspan = emptyColspan || headers.length
  const emptyRow = `<tr class="task-obs-table-row is-empty"><td colspan="${colspan}">${escHtml(emptyText || '暂无数据')}</td></tr>`
  const tableHtml = `
    <div class="task-obs-table-wrap">
      <table class="task-obs-table obs-data-table">
        <thead><tr>${headers.map((h) => `<th>${escHtml(h)}</th>`).join('')}</tr></thead>
        <tbody>${rowsHtml || emptyRow}</tbody>
      </table>
    </div>`
  if (!wrapPanel) return tableHtml
  return `
    <div class="task-obs-panel obs-table-panel">
      <div class="task-obs-panel-body">${tableHtml}</div>
    </div>`
}

export function obsTableActions(buttonsHtml) {
  return `<div class="obs-table-actions">${buttonsHtml}</div>`
}

export function obsCellMono(text, title = '') {
  const t = title ? ` title="${escHtml(title)}"` : ''
  return `<span class="obs-cell-mono"${t}>${escHtml(text)}</span>`
}

export function obsCellLink(text, threadId, title = '') {
  const t = title || text
  return `<button type="button" class="obs-cell-link" data-thread-id="${escHtml(threadId)}" title="${escHtml(t)}">${escHtml(text)}</button>`
}


/**
 * @param {{ items: Array<{ label: string, value: number }>, color?: string, valueFormatter?: (n: number) => string, emptyLabel?: string }} opts
 */
export function renderObsBarChart(opts) {
  const items = (opts.items || []).filter((i) => i && Number.isFinite(Number(i.value)))
  if (!items.length) {
    return `<div class="obs-chart-empty">${escHtml(opts.emptyLabel || '暂无趋势数据')}</div>`
  }
  const max = Math.max(...items.map((i) => Number(i.value)), 1)
  const fmt = opts.valueFormatter || ((n) => fmtNum(n))
  const color = opts.color || 'var(--accent)'
  return `
    <div class="usage-daily-chart obs-bar-chart" role="img" aria-label="柱状图">
      ${items
        .map((item) => {
          const v = Number(item.value)
          const pct = Math.max(2, Math.round((v / max) * 100))
          return `
        <div class="usage-daily-bar-wrap" title="${escHtml(item.label)}: ${escHtml(fmt(v))}">
          <div class="usage-daily-bar obs-bar-chart__bar" style="height:${pct}%;background:${color}"></div>
          <span class="usage-daily-label">${escHtml(item.label)}</span>
        </div>`
        })
        .join('')}
    </div>
  `
}

/**
 * Horizontal bar list for error/type distribution.
 * @param {{ rows: Array<{ label: string, value: number }>, valueFormatter?: (n: number) => string }} opts
 */
export function renderObsHBarList(opts) {
  const rows = opts.rows || []
  if (!rows.length) return `<div class="obs-chart-empty">暂无数据</div>`
  const max = Math.max(...rows.map((r) => Number(r.value)), 1)
  const fmt = opts.valueFormatter || ((n) => fmtNum(n))
  return `<div class="obs-hbar-list">
    ${rows
      .map((r) => {
        const v = Number(r.value)
        const pct = Math.max(4, Math.round((v / max) * 100))
        return `
      <div class="obs-hbar-row">
        <span class="obs-hbar-label" title="${escHtml(r.label)}">${escHtml(r.label)}</span>
        <div class="obs-hbar-track"><div class="obs-hbar-fill" style="width:${pct}%"></div></div>
        <span class="obs-hbar-value">${escHtml(fmt(v))}</span>
      </div>`
      })
      .join('')}
  </div>`
}

export function renderObsMenuCards(groups, values = {}) {
  return groups
    .map(
      (g) => `
    <button type="button" class="stat-card stat-card-clickable tasks-stat-card tasks-stat-card--${escHtml(g.tone || 'muted')}" data-obs-section="${escHtml(g.key)}">
      <div class="stat-card-label">${escHtml(g.label)}</div>
      <div class="stat-card-value">${escHtml(String(values[g.key] ?? '—'))}</div>
      <div class="stat-card-meta">${escHtml(g.hint || '')}</div>
    </button>`,
    )
    .join('')
}

export function renderObsMonitorHero({ label, mainValue, stats = [] }) {
  return `
    <div class="tasks-monitor-hero" id="obs-monitor-hero">
      <div class="tasks-monitor-hero-main">
        <span class="tasks-monitor-hero-label">${escHtml(label)}</span>
        <div class="tasks-monitor-hero-value" id="obs-monitor-main">${escHtml(mainValue)}</div>
      </div>
      <div class="tasks-monitor-hero-stats">
        ${stats
          .map(
            (s, i) => `
          <div class="tasks-monitor-hero-stat">
            <span class="tasks-monitor-hero-stat-value" id="obs-monitor-stat-${i}">${escHtml(s.value)}</span>
            <span class="tasks-monitor-hero-stat-label">${escHtml(s.label)}</span>
          </div>`,
          )
          .join('')}
      </div>
    </div>`
}

export function renderObsLoading() {
  return `<div class="obs-monitor-loading"><div class="stat-card loading-placeholder" style="height:220px"></div></div>`
}

export function renderObsError(message) {
  return `<div class="stat-card ops-error">${escHtml(message)}</div>`
}

/** @typedef {{ key: string, label: string, hint?: string, icon?: string }} ObsNavItem */

const OBS_NAV_ICONS = {
  overview: '📊',
  tools: '🔧',
  models: '🤖',
  gateway: '🌐',
  sessions: '💬',
  waterfall: '📈',
  report: '📋',
}

/**
 * @param {ObsNavItem[]} items
 * @param {string} activeKey
 */
export function renderObsSideNav(items, activeKey) {
  return items
    .map(
      (item) => `
    <button type="button" class="el-obs-menu-item${item.key === activeKey ? ' is-active' : ''}" data-obs-nav="${escHtml(item.key)}">
      <span class="el-obs-menu-icon">${escHtml(item.icon || OBS_NAV_ICONS[item.key] || '•')}</span>
      <span class="el-obs-menu-text">
        ${escHtml(item.label)}
        ${item.hint ? `<span class="el-obs-menu-hint">${escHtml(item.hint)}</span>` : ''}
      </span>
    </button>`,
    )
    .join('')
}

/**
 * @param {HTMLElement | null} navEl
 * @param {(key: string) => void} onSelect
 */
export function bindObsSideNav(navEl, onSelect) {
  if (!navEl) return
  navEl.querySelectorAll('[data-obs-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-obs-nav')
      if (!key) return
      navEl.querySelectorAll('[data-obs-nav]').forEach((b) => {
        b.classList.toggle('is-active', b.getAttribute('data-obs-nav') === key)
      })
      onSelect(key)
    })
  })
}

/**
 * @param {{ brandTitle: string, brandCaption?: string, navItems: ObsNavItem[], activeKey: string, topbarHtml?: string, bodyHtml: string }} opts
 */
export function renderObsConsoleShell(opts) {
  return `
    <div class="el-obs-layout obs-console">
      <aside class="el-obs-aside">
        <div class="el-obs-rail-brand">
          <div class="el-obs-rail-title">${escHtml(opts.brandTitle)}</div>
          ${opts.brandCaption ? `<div class="el-obs-rail-caption">${escHtml(opts.brandCaption)}</div>` : ''}
        </div>
        <nav class="el-obs-menu" id="obs-side-nav" role="navigation">${renderObsSideNav(opts.navItems, opts.activeKey)}</nav>
      </aside>
      <div class="el-obs-main">
        ${opts.topbarHtml || ''}
        <div class="el-obs-column">
          <div class="el-obs-panel" id="obs-main-panel">${opts.bodyHtml}</div>
        </div>
      </div>
    </div>`
}

export function renderObsTopbar({ title, subtitle = '', actionsHtml = '' }) {
  return `
    <div class="el-obs-topbar">
      <div>
        <h2 class="el-obs-page-title">${escHtml(title)}</h2>
        ${subtitle ? `<p class="el-obs-page-subtitle">${escHtml(subtitle)}</p>` : ''}
      </div>
      <div class="el-obs-topbar-grow"></div>
      ${actionsHtml}
    </div>`
}

/**
 * @param {Array<{ label: string, value: string, footer?: string }>} cards
 */
export function renderObsKpiGrid(cards) {
  return `<div class="el-obs-stat-grid">
    ${cards
      .map(
        (c) => `
      <div class="el-obs-stat-card">
        <div class="el-obs-stat-card__label">${escHtml(c.label)}</div>
        <div class="el-obs-stat-card__value">${escHtml(c.value)}</div>
        ${c.footer ? `<div class="el-obs-stat-card__footer">${c.footer}</div>` : ''}
      </div>`,
      )
      .join('')}
  </div>`
}

export function renderObsElmCard({ title, subtitle = '', bodyHtml = '' }) {
  return `
    <section class="el-obs-card">
      <header class="el-obs-card__header">
        <span>${escHtml(title)}</span>
        ${subtitle ? `<span class="el-obs-card__subtitle">${escHtml(subtitle)}</span>` : ''}
      </header>
      <div class="el-obs-card__body">${bodyHtml}</div>
    </section>`
}

/**
 * Normalize /api/observability/trends response to chart-friendly rows.
 * @param {Record<string, unknown> | null | undefined} trends
 */
export function parseTrendSeries(trends) {
  if (!trends || trends.enabled === false) {
    return { labels: [], toolCalls: [], modelCalls: [], toolErrors: [], avgToolMs: [], avgModelMs: [] }
  }
  const toolRows = Array.isArray(trends.tool_daily)
    ? trends.tool_daily
    : Array.isArray(trends.tool_invocation_trend)
      ? trends.tool_invocation_trend.map((r) => ({
          day: r.date || r.day,
          tool_calls: r.tool_invocations ?? r.tool_calls ?? 0,
          tool_errors: r.tool_errors ?? 0,
          avg_duration_ms: r.avg_duration_ms,
        }))
      : []
  const modelRows = Array.isArray(trends.model_daily) ? trends.model_daily : []
  const daySet = new Set()
  toolRows.forEach((r) => {
    const d = String(r.day || '').slice(0, 10)
    if (d) daySet.add(d)
  })
  modelRows.forEach((r) => {
    const d = String(r.day || '').slice(0, 10)
    if (d) daySet.add(d)
  })
  const labels = [...daySet].sort()
  const toolMap = Object.fromEntries(toolRows.map((r) => [String(r.day || '').slice(0, 10), r]))
  const modelMap = Object.fromEntries(modelRows.map((r) => [String(r.day || '').slice(0, 10), r]))
  return {
    labels,
    toolCalls: labels.map((d) => Number(toolMap[d]?.tool_calls || 0)),
    toolErrors: labels.map((d) => Number(toolMap[d]?.tool_errors || 0)),
    avgToolMs: labels.map((d) => Number(toolMap[d]?.avg_duration_ms || 0)),
    modelCalls: labels.map((d) => Number(modelMap[d]?.model_calls || 0)),
    avgModelMs: labels.map((d) => Number(modelMap[d]?.avg_latency_ms || 0)),
  }
}

/**
 * @param {{ labels: string[], series: Array<{ name: string, color: string, values: number[] }>, height?: number, emptyLabel?: string }} opts
 */
export function renderObsLineChart(opts) {
  const labels = opts.labels || []
  const series = (opts.series || []).filter((s) => s.values?.length)
  if (!labels.length || !series.length) {
    return `<div class="obs-chart-empty">${escHtml(opts.emptyLabel || '暂无趋势数据')}</div>`
  }
  const all = series.flatMap((s) => s.values.map(Number)).filter(Number.isFinite)
  const max = Math.max(...all, 1)
  const min = Math.min(0, ...all)
  const range = max - min || 1
  const h = opts.height || 56
  const padX = 6
  const padY = 8
  const w = 100

  const toPoints = (values) =>
    values
      .map((v, i) => {
        const x = padX + (i / Math.max(1, values.length - 1)) * (w - padX * 2)
        const y = h - padY - ((Number(v) - min) / range) * (h - padY * 2)
        return `${x.toFixed(2)},${y.toFixed(2)}`
      })
      .join(' ')

  const shortLabels = labels.map((d) => String(d).slice(5) || d)

  return `
    <div class="obs-line-chart" role="img" aria-label="折线图">
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        ${series
          .map(
            (s) =>
              `<polyline fill="none" stroke="${escHtml(s.color)}" stroke-width="1.8" vector-effect="non-scaling-stroke" points="${toPoints(s.values)}"/>`,
          )
          .join('')}
      </svg>
      <div class="obs-line-chart-labels">${shortLabels.map((l) => `<span>${escHtml(l)}</span>`).join('')}</div>
      <div class="obs-line-chart-legend">${series
        .map((s) => `<span><i style="background:${escHtml(s.color)}"></i>${escHtml(s.name)}</span>`)
        .join('')}</div>
    </div>`
}

export function renderObsTrendCharts(trends, rangeLabel) {
  const t = parseTrendSeries(trends)
  if (!t.labels.length) return ''
  const toolChart = renderObsElmCard({
    title: '工具调用趋势',
    subtitle: rangeLabel,
    bodyHtml: renderObsLineChart({
      labels: t.labels,
      series: [
        { name: '调用次数', color: '#409eff', values: t.toolCalls },
        { name: '错误次数', color: '#f56c6c', values: t.toolErrors },
      ],
    }),
  })
  const modelChart = renderObsElmCard({
    title: '模型请求趋势',
    subtitle: rangeLabel,
    bodyHtml: renderObsLineChart({
      labels: t.labels,
      series: [{ name: '请求次数', color: '#67c23a', values: t.modelCalls }],
    }),
  })
  return `<div class="obs-charts-row">${toolChart}${modelChart}</div>`
}

let _sessionTitleMapCache = /** @type {Map<string, string> | null} */ (null)
let _sessionTitleMapInflight = /** @type {Promise<Map<string, string>> | null} */ (null)

const THREAD_TITLE_STORAGE_KEY = 'evopanel_thread_title_map_v1'

function persistThreadTitleMapToStorage(map) {
  try {
    const entries = Object.fromEntries(map.entries())
    localStorage.setItem(
      THREAD_TITLE_STORAGE_KEY,
      JSON.stringify({ version: 1, entries, updatedAt: Date.now() }),
    )
  } catch {
    /* ignore */
  }
}

function hydrateThreadTitleMapFromStorage(map) {
  try {
    const raw = localStorage.getItem(THREAD_TITLE_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    for (const [tid, title] of Object.entries(parsed?.entries || {})) {
      const id = String(tid || '').trim()
      const label = String(title || '').trim()
      if (!id || !label || label === '新对话') continue
      map.set(id, label)
    }
  } catch {
    /* ignore */
  }
}

function mergeSessionsIntoTitleMap(map, sessions) {
  for (const s of sessions) {
    const tid = String(s.threadId || s.thread_id || '').trim()
    const title = String(s.title || '').trim()
    if (!tid || !title || title === '新对话') continue
    map.set(tid, title)
  }
  persistThreadTitleMapToStorage(map)
}

/**
 * Best-effort session titles for observability pages. Never throws; uses silent
 * gateway fetch with timeout so agent-trace works when chat sessions API is down.
 *
 * @param {object} [_apiClient] legacy arg, ignored (kept for call-site compat)
 * @param {{ force?: boolean, limit?: number, timeoutMs?: number }} [options]
 */
export async function loadSessionTitleMap(_apiClient, options = {}) {
  if (!options.force && _sessionTitleMapCache) return _sessionTitleMapCache
  if (_sessionTitleMapInflight) return _sessionTitleMapInflight

  const limit = Math.min(100, Math.max(1, Number(options.limit) || 100))
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || 4000)

  _sessionTitleMapInflight = (async () => {
    const map = new Map()
    hydrateThreadTitleMapFromStorage(map)
    try {
      const { gatewayProxy } = await import('./tauri-api.js')
      const res = await Promise.race([
        gatewayProxy(
          'GET',
          '/chat/sessions',
          null,
          { limit: String(limit), offset: '0' },
          { silent: true },
        ),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('session title fetch timeout')), timeoutMs)
        }),
      ])
      const sessions = res?.sessions || res?.items || []
      mergeSessionsIntoTitleMap(map, sessions)
    } catch {
      /* ignore — titles are optional enrichment */
    }
    _sessionTitleMapCache = map
    return map
  })().finally(() => {
    _sessionTitleMapInflight = null
  })

  return _sessionTitleMapInflight
}

export function sessionDisplayTitle(threadId, titleMap) {
  const tid = String(threadId || '').trim()
  return (titleMap?.get(tid) || '').trim() || '未命名会话'
}
