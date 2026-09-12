/**
 * 设置：使用统计仪表盘（主库费用账本 /api/usage）
 * 图表样式对齐运维观测 Charts（多折线 + PaletteDonut）
 */
import { api } from '../../lib/tauri-api.js'
import { t } from '../../lib/i18n.js'
import { getCachedMe, refreshMe } from '../../lib/account-session.js'

/** @type {AbortController | null} */
let _abort = null
/** @type {number} */
let _periodDays = 7

const SERIES_COLORS = ['#3b82f6', '#22c55e', '#a855f7', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16']

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatTokens(n) {
  const v = Number(n) || 0
  if (v >= 10_000_000) return `${(v / 10_000).toFixed(0)}万`
  if (v >= 10_000) return `${(v / 10_000).toFixed(1).replace(/\.0$/, '')}万`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return String(Math.round(v))
}

function formatAmount(n) {
  const v = Number(n) || 0
  if (v <= 0) return '—'
  if (v < 0.01) return `$${v.toFixed(4)}`
  return `$${v.toFixed(2)}`
}

function rangeDays(days) {
  const end = new Date()
  const to = end.toISOString().slice(0, 10)
  const start = new Date(end.getTime() - (Math.max(1, days) - 1) * 86400000)
  const from = start.toISOString().slice(0, 10)
  return { from, to }
}

function formatAxisDay(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return iso
  return `${Number(m[2])}月${Number(m[3])}日`
}

function scalePoints(data, width, height, padding = 24) {
  const min = 0
  const max = Math.max(...data, 1)
  const range = Math.max(max - min, 1)
  return data.map((value, index) => {
    const x = padding + (index / Math.max(data.length - 1, 1)) * (width - padding * 2)
    const y = height - padding - ((value - min) / range) * (height - padding * 2)
    return { x, y, value }
  })
}

function toPolyline(points) {
  return points.map((p) => `${p.x},${p.y}`).join(' ')
}

/**
 * Multi-series line chart (obs MultiLineAreaChart style)
 * @param {{ days: string[], series: Array<{ sku: string, points: Array<{ day: string, quantity_sum: number }> }> }} payload
 */
function buildMultiLineChart(payload) {
  const days = payload?.days || []
  const series = payload?.series || []
  if (!days.length || !series.length) {
    return `<div class="settings-usage-empty">${esc(t('usage.noData'))}</div>`
  }

  const width = 800
  const height = 280
  const padding = 28
  const allVals = series.flatMap((s) => (s.points || []).map((p) => Number(p.quantity_sum) || 0))
  if (!allVals.some((v) => v > 0)) {
    return `<div class="settings-usage-empty">${esc(t('usage.noData'))}</div>`
  }

  const max = Math.max(...allVals, 1)
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => Math.round(max * r))
  const grid = yTicks
    .map((_, index) => {
      const y = padding + index * ((height - padding * 2) / Math.max(yTicks.length - 1, 1))
      return `<line x1="${padding}" x2="${width - padding}" y1="${y}" y2="${y}" class="su-grid-line" />`
    })
    .join('')

  const polylines = series
    .map((s, i) => {
      const vals = days.map((d) => {
        const pt = (s.points || []).find((p) => p.day === d)
        return Number(pt?.quantity_sum) || 0
      })
      const pts = scalePoints(vals, width, height, padding)
      const color = SERIES_COLORS[i % SERIES_COLORS.length]
      const area =
        i === 0
          ? `<polygon points="${padding},${height - padding} ${toPolyline(pts)} ${width - padding},${height - padding}" fill="url(#suFill0)" opacity="0.9" />`
          : ''
      return `${area}<polyline points="${toPolyline(pts)}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`
    })
    .join('')

  const legend = series
    .map((s, i) => {
      const color = SERIES_COLORS[i % SERIES_COLORS.length]
      return `<span class="su-legend-item"><i style="background:${color}"></i>${esc(s.sku)}</span>`
    })
    .join('')

  const xLabels = days
    .map((d) => `<span>${esc(formatAxisDay(d))}</span>`)
    .join('')

  const yLabels = yTicks
    .slice()
    .reverse()
    .map((tick) => `<span>${esc(formatTokens(tick))}</span>`)
    .join('')

  return `
    <div class="su-chart-wrap">
      <div class="su-legend">${legend}</div>
      <svg class="su-big-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="每日 Token 趋势">
        <defs>
          <linearGradient id="suFill0" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="rgba(59, 130, 246, .32)" />
            <stop offset="1" stop-color="rgba(59, 130, 246, 0)" />
          </linearGradient>
        </defs>
        ${grid}
        ${polylines}
      </svg>
      <div class="su-axis su-x-axis">${xLabels}</div>
      <div class="su-axis su-y-axis">${yLabels}</div>
    </div>`
}

/**
 * Donut (obs PaletteDonut style)
 * @param {Array<{ sku: string, quantity_sum: number }>} items
 * @param {number} total
 */
function buildDonutHtml(items, total) {
  const list = (items || []).filter((x) => Number(x.quantity_sum) > 0).slice(0, 8)
  if (!list.length || total <= 0) {
    return `<div class="settings-usage-empty">${esc(t('usage.noModelData'))}</div>`
  }
  let offset = 0
  const stops = []
  const legend = []
  list.forEach((row, i) => {
    const q = Number(row.quantity_sum) || 0
    const pct = Math.round((q / total) * 1000) / 10
    const color = SERIES_COLORS[i % SERIES_COLORS.length]
    const start = offset
    offset += pct
    stops.push(`${color} ${start}% ${offset}%`)
    legend.push(`
      <div class="su-donut-legend-row">
        <span class="su-dot" style="background:${color}"></span>
        <span class="su-donut-name">${esc(row.sku)}</span>
        <strong>${esc(formatTokens(q))}</strong>
        <em>${pct}%</em>
      </div>`)
  })
  if (offset < 100) stops.push(`var(--bg-secondary, #e5e7eb) ${offset}% 100%`)

  return `
    <div class="su-donut-layout">
      <div class="su-donut" style="background:conic-gradient(${stops.join(', ')})" aria-label="模型用量">
        <div class="su-donut-center">
          <strong>${esc(formatTokens(total))}</strong>
          <span>tokens</span>
        </div>
      </div>
      <div class="su-donut-legend">${legend.join('')}</div>
    </div>`
}

/**
 * @param {Array<any>} items
 */
function buildByUserTable(items) {
  const rows = Array.isArray(items) ? items : []
  if (!rows.length) {
    return `<div class="settings-usage-empty">${esc(t('usage.noData'))}</div>`
  }
  const body = rows
    .map((r) => {
      const label = String(r.label || r.display_name || r.principal_id || t('usage.orphanUser')).trim()
      const pid = String(r.principal_id || '').trim()
      return `
      <tr>
        <td>
          <div class="su-user-cell">
            <strong>${esc(label)}</strong>
            ${pid ? `<span class="su-user-pid">${esc(pid)}</span>` : ''}
          </div>
        </td>
        <td class="su-num">${esc(formatTokens(r.quantity_sum))}</td>
        <td class="su-num">${esc(formatAmount(r.amount_sum))}</td>
        <td class="su-num">${esc(formatAmount(r.proactive_cost_usd))}</td>
        <td class="su-num su-num--emph">${esc(formatAmount(r.total_amount_sum ?? (Number(r.amount_sum) || 0) + (Number(r.proactive_cost_usd) || 0)))}</td>
        <td class="su-num">${Number(r.event_count) || 0}</td>
      </tr>`
    })
    .join('')
  return `
    <div class="su-user-table-wrap">
      <table class="su-user-table">
        <thead>
          <tr>
            <th>${esc(t('usage.userCol'))}</th>
            <th>${esc(t('usage.tokens'))}</th>
            <th>${esc(t('usage.chatCost'))}</th>
            <th>${esc(t('usage.proactiveCost'))}</th>
            <th>${esc(t('usage.totalCost'))}</th>
            <th>${esc(t('usage.calls'))}</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`
}

function renderSkeleton() {
  return `
    <div class="settings-usage settings-usage--dash">
      <div class="settings-usage-head">
        <div>
          <h2 class="settings-usage-title">${esc(t('usage.title'))}</h2>
          <p class="settings-usage-desc">${esc(t('usage.desc'))}</p>
        </div>
      </div>
      <div class="settings-usage-empty">${esc(t('usage.loading'))}</div>
    </div>`
}

/**
 * @param {HTMLElement} container
 * @param {any} data
 */
function renderBody(container, data) {
  const summary = data.summary || {}
  const bySku = data.bySku?.items || []
  const dailyBySku = data.dailyBySku || {}
  const cats = data.byCategory?.items || []
  const byPrincipal = data.byPrincipal?.items || null
  const llmTotal = Number(summary.llm_token_sum ?? summary.quantity_sum) || 0

  const catChips = cats.length
    ? cats
        .map((c) => {
          const label =
            c.category === 'llm'
              ? t('usage.tabModels')
              : c.category === 'tool'
                ? t('usage.tabTools')
                : c.category === 'media'
                  ? '媒体'
                  : c.category
          return `
      <div class="settings-usage-cat-chip">
        <strong>${esc(label)}</strong>
        <span>${formatTokens(c.quantity_sum)} · ${Number(c.event_count) || 0} ${esc(t('usage.calls'))}</span>
      </div>`
        })
        .join('')
    : `<div class="settings-usage-empty">${esc(t('usage.noData'))}</div>`

  const byUserSection =
    byPrincipal != null
      ? `
      <section class="settings-usage-card">
        <h3 class="settings-usage-card-title">${esc(t('usage.byUser'))}</h3>
        <p class="settings-usage-card-hint">${esc(t('usage.byUserHint'))}</p>
        ${buildByUserTable(byPrincipal)}
      </section>`
      : ''

  container.innerHTML = `
    <div class="settings-usage settings-usage--dash">
      <div class="settings-usage-head">
        <div>
          <h2 class="settings-usage-title">${esc(t('usage.title'))}</h2>
          <p class="settings-usage-desc">${esc(t('usage.desc'))} · UTC</p>
        </div>
        <div class="settings-usage-head-actions">
          <div class="settings-usage-period" role="group" aria-label="时间范围">
            <button type="button" class="settings-usage-period-btn${_periodDays === 7 ? ' is-active' : ''}" data-usage-days="7">${esc(t('usage.period7d'))}</button>
            <button type="button" class="settings-usage-period-btn${_periodDays === 30 ? ' is-active' : ''}" data-usage-days="30">${esc(t('usage.period30d'))}</button>
          </div>
          <button type="button" class="btn btn-sm btn-secondary" data-usage-refresh>刷新</button>
        </div>
      </div>

      <div class="settings-usage-kpis">
        <div class="settings-usage-kpi">
          <div class="settings-usage-kpi-label">${esc(t('usage.totalTokens'))}</div>
          <div class="settings-usage-kpi-value">${formatTokens(llmTotal)}</div>
        </div>
        <div class="settings-usage-kpi">
          <div class="settings-usage-kpi-label">${esc(t('usage.totalCost'))}</div>
          <div class="settings-usage-kpi-value">${formatAmount(summary.amount_sum)}</div>
        </div>
        <div class="settings-usage-kpi">
          <div class="settings-usage-kpi-label">${esc(t('usage.requestCount'))}</div>
          <div class="settings-usage-kpi-value">${Number(summary.event_count) || 0}</div>
        </div>
        <div class="settings-usage-kpi">
          <div class="settings-usage-kpi-label">峰值日 Token</div>
          <div class="settings-usage-kpi-value" title="${esc(summary.peak_day || '')}">${formatTokens(summary.peak_quantity)}</div>
        </div>
      </div>

      <div class="su-dash-row">
        <section class="settings-usage-card su-dash-trend">
          <h3 class="settings-usage-card-title">每日 Token 趋势图</h3>
          ${buildMultiLineChart(dailyBySku)}
        </section>
        <section class="settings-usage-card su-dash-donut">
          <h3 class="settings-usage-card-title">${esc(t('usage.tabModels'))}</h3>
          ${buildDonutHtml(bySku, llmTotal || bySku.reduce((s, r) => s + (Number(r.quantity_sum) || 0), 0))}
        </section>
      </div>

      ${byUserSection}

      <section class="settings-usage-card">
        <h3 class="settings-usage-card-title">类型用量</h3>
        <div class="settings-usage-cats">${catChips}</div>
      </section>
    </div>
  `
}

async function loadAndRender(container) {
  _abort?.abort()
  _abort = new AbortController()
  const { from, to } = rangeDays(_periodDays)
  container.innerHTML = renderSkeleton()
  try {
    if (!getCachedMe()) {
      try {
        await refreshMe()
      } catch {
        /* ignore */
      }
    }
    const isAdmin = Boolean(getCachedMe()?.isOrgAdmin)
    const tasks = [
      api.usageSummary({ from, to }),
      api.usageDailyBySku({ from, to, category: 'llm', top_n: 6 }),
      api.usageByCategory({ from, to }),
      api.usageBySku({ from, to, category: 'llm' }),
    ]
    if (isAdmin) tasks.push(api.usageByPrincipal({ from, to }))
    const results = await Promise.all(tasks)
    const [summary, dailyBySku, byCategory, bySku] = results
    const byPrincipal = isAdmin ? results[4] : null
    if (!container.isConnected) return
    renderBody(container, { summary, dailyBySku, byCategory, bySku, byPrincipal })
  } catch (e) {
    if (!container.isConnected) return
    const msg = String(e?.message || e || '')
    const hint = /404|Not Found|Failed to fetch|Network/i.test(msg)
      ? t('usage.waitingGateway')
      : t('usage.noData')
    container.innerHTML = `
      <div class="settings-usage settings-usage--dash">
        <h2 class="settings-usage-title">${esc(t('usage.title'))}</h2>
        <div class="settings-usage-empty">${esc(hint)}<br/><span style="font-size:12px;opacity:.7">${esc(msg)}</span></div>
      </div>`
  }
}

/**
 * @param {HTMLElement} container
 */
export async function mountUsageInto(container) {
  container.classList.add('settings-modal-pane--usage')
  container.addEventListener('click', (e) => {
    if (e.target.closest('[data-usage-refresh]')) {
      e.preventDefault()
      void loadAndRender(container)
      return
    }
    const btn = e.target.closest('[data-usage-days]')
    if (!btn) return
    const days = Number(btn.getAttribute('data-usage-days')) || 7
    if (days === _periodDays) return
    _periodDays = days
    void loadAndRender(container)
  })
  await loadAndRender(container)
}

export function cleanup() {
  _abort?.abort()
  _abort = null
}
