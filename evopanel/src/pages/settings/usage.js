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
/** @type {'overview' | 'modules'} */
let _view = 'overview'
/** @type {'all' | 'chat' | 'employee' | 'workflow' | 'knowledge' | 'media' | 'other'} */
let _moduleFilter = 'all'
/** @type {string} */
let _moduleQuery = ''
/** @type {any | null} */
let _lastData = null

const SERIES_COLORS = ['#3b82f6', '#22c55e', '#a855f7', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16']

const MODULE_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'chat', label: '对话' },
  { id: 'employee', label: 'BOT' },
  { id: 'workflow', label: '工作流' },
  { id: 'knowledge', label: '知识库' },
  { id: 'media', label: '生图/生视频' },
  { id: 'other', label: '其它' },
]

const PURPOSE_ZH = { index: '索引写入', query: '检索查询', other: '其它' }

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

function formatShare(n) {
  const v = Number(n) || 0
  if (v <= 0) return '—'
  return `${(v * 100).toFixed(1)}%`
}

/**
 * @param {string} q
 * @param {Array<{ label?: string }>} rows
 */
function filterRowsByQuery(rows, q) {
  const needle = String(q || '')
    .trim()
    .toLowerCase()
  if (!needle) return rows
  return rows.filter((r) => String(r.label || '').toLowerCase().includes(needle))
}

/**
 * Ranked detail table for one module surface.
 * @param {Array<{ label?: string, tokens?: number, share?: number, events?: number, amount?: number }>} rows
 * @param {string} emptyText
 * @param {{ showAmount?: boolean }} [opts]
 */
function buildModuleDetailTable(rows, emptyText, opts = {}) {
  const list = Array.isArray(rows) ? rows.filter((r) => (Number(r.tokens) || 0) > 0) : []
  if (!list.length) {
    return `<div class="settings-usage-empty">${esc(emptyText)}</div>`
  }
  const showAmount = opts.showAmount !== false
  const max = Math.max(...list.map((r) => Number(r.tokens) || 0), 1)
  const body = list
    .map((r, i) => {
      const tokens = Number(r.tokens) || 0
      const pct = Math.max(3, (tokens / max) * 100)
      return `
      <tr>
        <td class="su-num su-module-rank">${i + 1}</td>
        <td>
          <div class="su-module-item-label" title="${esc(r.label || '')}">${esc(r.label || '—')}</div>
          <div class="su-module-item-track"><i style="width:${pct}%"></i></div>
        </td>
        <td class="su-num">${esc(formatTokens(tokens))}</td>
        <td class="su-num">${esc(formatShare(r.share))}</td>
        <td class="su-num">${Number(r.events) || 0}</td>
        ${showAmount ? `<td class="su-num">${esc(formatAmount(r.amount))}</td>` : ''}
      </tr>`
    })
    .join('')
  return `
    <div class="su-user-table-wrap">
      <table class="su-user-table su-module-table">
        <thead>
          <tr>
            <th>#</th>
            <th>名称</th>
            <th>Token</th>
            <th>占比</th>
            <th>次数</th>
            ${showAmount ? '<th>费用</th>' : ''}
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`
}

/**
 * Shared chrome: view switcher + period + refresh.
 * @param {string} title
 * @param {string} desc
 */
function buildUsageChrome(title, desc) {
  return `
    <div class="settings-usage-head">
      <div>
        <h2 class="settings-usage-title">${esc(title)}</h2>
        <p class="settings-usage-desc">${esc(desc)}</p>
      </div>
      <div class="settings-usage-head-actions">
        <div class="settings-usage-period" role="tablist" aria-label="视图">
          <button type="button" class="settings-usage-period-btn${_view === 'overview' ? ' is-active' : ''}" data-usage-view="overview" role="tab" aria-selected="${_view === 'overview' ? 'true' : 'false'}">总览</button>
          <button type="button" class="settings-usage-period-btn${_view === 'modules' ? ' is-active' : ''}" data-usage-view="modules" role="tab" aria-selected="${_view === 'modules' ? 'true' : 'false'}">按模块</button>
        </div>
        <div class="settings-usage-period" role="group" aria-label="时间范围">
          <button type="button" class="settings-usage-period-btn${_periodDays === 7 ? ' is-active' : ''}" data-usage-days="7">${esc(t('usage.period7d'))}</button>
          <button type="button" class="settings-usage-period-btn${_periodDays === 30 ? ' is-active' : ''}" data-usage-days="30">${esc(t('usage.period30d'))}</button>
        </div>
        <button type="button" class="btn btn-sm btn-secondary" data-usage-refresh>刷新</button>
      </div>
    </div>`
}

/**
 * Dedicated module panel (not crammed into overview).
 * @param {any} byModule
 */
function buildModulesPanel(byModule) {
  if (!byModule || typeof byModule !== 'object') {
    return `
      <section class="settings-usage-card">
        <h3 class="settings-usage-card-title">模块用量</h3>
        <div class="settings-usage-empty">模块明细暂不可用（需 Gateway 支持 /api/usage/by-module，请重启桌面端后刷新）</div>
      </section>`
  }

  const modules = Array.isArray(byModule.modules) ? byModule.modules : []
  const moduleMap = Object.fromEntries(modules.map((m) => [m.module, m]))
  const totalTokens = Number(byModule.total_tokens) || modules.reduce((s, m) => s + (Number(m.tokens) || 0), 0)

  const chips = MODULE_FILTERS.map((f) => {
    // Hide empty niche filters; keep primary surfaces always visible.
    if ((f.id === 'other' || f.id === 'media') && !moduleMap[f.id]) return ''
    return `
      <button type="button" class="su-module-chip${_moduleFilter === f.id ? ' is-active' : ''}" data-usage-module-filter="${f.id}">
        ${esc(f.label)}
      </button>`
  }).join('')

  const cards = ['chat', 'employee', 'workflow', 'knowledge']
    .concat(moduleMap.media ? ['media'] : [])
    .concat(moduleMap.other ? ['other'] : [])
    .map((id) => {
      const meta = MODULE_FILTERS.find((f) => f.id === id)
      const slot = moduleMap[id]
      const tokens = Number(slot?.tokens) || 0
      const share = Number(slot?.share) || 0
      const events = Number(slot?.events) || 0
      const active = _moduleFilter === id ? ' is-active' : ''
      return `
        <button type="button" class="su-module-card${active}" data-usage-module-filter="${id}">
          <span class="su-module-card-name">${esc(meta?.label || id)}</span>
          <strong class="su-module-card-tokens">${esc(formatTokens(tokens))}</strong>
          <span class="su-module-card-meta">${esc(formatShare(share))} · ${events} 次</span>
        </button>`
    })
    .join('')

  /** @type {{ title: string, hint: string, rows: any[], empty: string }} */
  let detail = { title: '', hint: '', rows: [], empty: '暂无数据' }
  const q = _moduleQuery

  if (_moduleFilter === 'all') {
    detail = {
      title: '模块合计',
      hint: '点上方模块卡片或筛选按钮，查看该模块下的具体对话 / 员工 / 工作流 / 知识库。',
      rows: filterRowsByQuery(
        modules.map((m) => ({
          ...m,
          label: m.label || m.module,
        })),
        q,
      ),
      empty: '当前区间暂无模块用量',
    }
  } else if (_moduleFilter === 'chat') {
    detail = {
      title: '对话明细',
      hint: '普通聊天会话（不含员工值班会话）。',
      rows: filterRowsByQuery(
        (byModule.conversations || []).filter((r) => (r.module || 'chat') === 'chat'),
        q,
      ),
      empty: '暂无对话用量',
    }
  } else if (_moduleFilter === 'employee') {
    const empRows = (byModule.employees || []).length
      ? byModule.employees
      : (byModule.conversations || []).filter((r) => r.module === 'employee')
    detail = {
      title: 'BOT 明细',
      hint: '按员工汇总；也可在搜索框输入员工名或会话标题。',
      rows: filterRowsByQuery(empRows, q),
      empty: '暂无员工用量',
    }
  } else if (_moduleFilter === 'workflow') {
    detail = {
      title: '工作流明细',
      hint: '按工作流 / App 汇总。',
      rows: filterRowsByQuery(byModule.workflows || [], q),
      empty: '暂无工作流用量',
    }
  } else if (_moduleFilter === 'knowledge') {
    const kbRows = (byModule.knowledge_bases || []).map((r) => {
      const purposeZh = PURPOSE_ZH[r.top_purpose] || ''
      return {
        ...r,
        label: purposeZh ? `${r.label || r.kb_id} · ${purposeZh}` : r.label || r.kb_id,
      }
    })
    const purposeRows = (byModule.knowledge || []).map((r) => ({
      ...r,
      label: `用途 · ${r.label || PURPOSE_ZH[r.purpose] || r.purpose}`,
    }))
    detail = {
      title: '知识库明细',
      hint: '先按知识库，再按用途（索引 / 检索）。',
      rows: filterRowsByQuery([...kbRows, ...purposeRows], q),
      empty: '暂无知识库用量',
    }
  } else if (_moduleFilter === 'media') {
    const slot = moduleMap.media
    detail = {
      title: '生图 / 生视频',
      hint: '媒体类调用合计（按模块汇总，暂无更细条目）。',
      rows: slot
        ? filterRowsByQuery([{ ...slot, label: slot.label || '生图/生视频' }], q)
        : [],
      empty: '暂无媒体用量',
    }
  } else {
    const slot = moduleMap[_moduleFilter]
    detail = {
      title: MODULE_FILTERS.find((f) => f.id === _moduleFilter)?.label || _moduleFilter,
      hint: '',
      rows: slot
        ? filterRowsByQuery([{ ...slot, label: slot.label || _moduleFilter }], q)
        : [],
      empty: '暂无数据',
    }
  }

  return `
    <div class="su-module-panel">
      <div class="su-module-toolbar">
        <div class="su-module-chips" role="tablist" aria-label="模块筛选">${chips}</div>
        <label class="su-module-search">
          <input type="search" placeholder="搜索名称…" value="${esc(_moduleQuery)}" data-usage-module-q aria-label="搜索模块条目" />
        </label>
      </div>

      <div class="su-module-summary">
        <div class="su-module-summary-total">
          <span>区间合计</span>
          <strong>${esc(formatTokens(totalTokens))}</strong>
          <em>tokens · UTC</em>
        </div>
        <div class="su-module-cards">${cards || `<div class="settings-usage-empty">暂无模块数据</div>`}</div>
      </div>

      <section class="settings-usage-card su-module-detail">
        <div class="su-module-detail-head">
          <h3 class="settings-usage-card-title">${esc(detail.title)}</h3>
          ${detail.hint ? `<p class="settings-usage-card-hint">${esc(detail.hint)}</p>` : ''}
        </div>
        ${buildModuleDetailTable(detail.rows, detail.empty)}
      </section>
    </div>`
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

function formatCalls(n) {
  const v = Number(n) || 0
  return v > 0 ? String(v) : '—'
}

/**
 * Per-day consumption table (chat / image / video / embedding / cost).
 * @param {{ days?: Array<any> } | null | undefined} payload
 */
function buildDailyBreakdownTable(payload) {
  const days = Array.isArray(payload?.days) ? payload.days : []
  const active = days.filter(
    (d) =>
      (Number(d.llm_tokens) || 0) > 0 ||
      (Number(d.llm_calls) || 0) > 0 ||
      (Number(d.image_calls) || 0) > 0 ||
      (Number(d.video_calls) || 0) > 0 ||
      (Number(d.embed_tokens) || 0) > 0 ||
      (Number(d.embed_calls) || 0) > 0 ||
      (Number(d.amount_sum) || 0) > 0,
  )
  if (!active.length) {
    return `<div class="settings-usage-empty">${esc(t('usage.noData'))}</div>`
  }
  const body = active
    .map((d) => {
      const img = Number(d.image_calls) || 0
      const vid = Number(d.video_calls) || 0
      const embTok = Number(d.embed_tokens) || 0
      const embCalls = Number(d.embed_calls) || 0
      const embedCell =
        embTok > 0 || embCalls > 0
          ? `${formatTokens(embTok)}<small class="su-cell-sub"> · ${embCalls} 次</small>`
          : '—'
      return `
      <tr>
        <td><strong>${esc(formatAxisDay(d.day))}</strong><span class="su-user-pid">${esc(d.day || '')}</span></td>
        <td class="su-num">${esc(formatTokens(d.llm_tokens))}</td>
        <td class="su-num">${esc(formatCalls(d.llm_calls))}</td>
        <td class="su-num">${esc(formatCalls(img))}</td>
        <td class="su-num">${esc(formatCalls(vid))}</td>
        <td class="su-num">${embedCell}</td>
        <td class="su-num su-num--emph">${esc(formatAmount(d.amount_sum))}</td>
      </tr>`
    })
    .join('')
  return `
    <div class="su-user-table-wrap">
      <table class="su-user-table su-daily-table">
        <thead>
          <tr>
            <th>日期 (UTC)</th>
            <th>聊天 Token</th>
            <th>聊天次数</th>
            <th>生图</th>
            <th>生视频</th>
            <th>向量</th>
            <th>费用</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`
}

function renderSkeleton() {
  return `
    <div class="settings-usage settings-usage--dash">
      ${buildUsageChrome(t('usage.title'), t('usage.desc'))}
      <div class="settings-usage-empty">${esc(t('usage.loading'))}</div>
    </div>`
}

/**
 * @param {HTMLElement} container
 * @param {any} data
 */
function renderOverview(container, data) {
  const summary = data.summary || {}
  const bySku = data.bySku?.items || []
  const dailyBySku = data.dailyBySku || {}
  const dailyBreakdown = data.dailyBreakdown || {}
  const cats = data.byCategory?.items || []
  const byPrincipal = data.byPrincipal?.items || null
  const llmTotal = Number(summary.llm_token_sum ?? summary.quantity_sum) || 0
  const mediaCat = cats.find((c) => c.category === 'media') || null
  const mediaCalls = Number(mediaCat?.event_count) || 0
  const mediaAmount = Number(mediaCat?.amount_sum) || 0
  const embedCat = cats.find((c) => c.category === 'embedding') || null
  const embedTokens = Number(embedCat?.quantity_sum) || 0
  const embedCalls = Number(embedCat?.event_count) || 0
  const embedAmount = Number(embedCat?.amount_sum) || 0

  const catChips = cats.length
    ? cats
        .map((c) => {
          const label =
            c.category === 'llm'
              ? t('usage.tabModels')
              : c.category === 'tool'
                ? t('usage.tabTools')
                : c.category === 'media'
                  ? '生图/生视频'
                  : c.category === 'embedding'
                    ? '向量 Embedding'
                    : c.category
          const qtyLabel =
            c.category === 'media'
              ? `${Number(c.event_count) || 0} 次 · ${formatAmount(c.amount_sum)}`
              : c.category === 'embedding'
                ? `${formatTokens(c.quantity_sum)} · ${Number(c.event_count) || 0} ${esc(t('usage.calls'))} · ${formatAmount(c.amount_sum)}`
                : `${formatTokens(c.quantity_sum)} · ${Number(c.event_count) || 0} ${esc(t('usage.calls'))}`
          return `
      <div class="settings-usage-cat-chip">
        <strong>${esc(label)}</strong>
        <span>${qtyLabel}</span>
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
      ${buildUsageChrome(t('usage.title'), `${t('usage.desc')} · UTC`)}

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
          <div class="settings-usage-kpi-value">${Number(summary.llm_event_count ?? summary.event_count) || 0}</div>
        </div>
        <div class="settings-usage-kpi">
          <div class="settings-usage-kpi-label">峰值日 Token</div>
          <div class="settings-usage-kpi-value" title="${esc(summary.peak_day || '')}">${formatTokens(summary.peak_quantity)}</div>
        </div>
        <div class="settings-usage-kpi">
          <div class="settings-usage-kpi-label">生图/生视频</div>
          <div class="settings-usage-kpi-value" title="媒体调用次数（含估价）">${mediaCalls}<small style="font-size:12px;opacity:.7"> 次</small></div>
          <div class="settings-usage-kpi-sub">${formatAmount(mediaAmount)}</div>
        </div>
        <div class="settings-usage-kpi">
          <div class="settings-usage-kpi-label">向量 Embedding</div>
          <div class="settings-usage-kpi-value" title="知识库建库/检索等向量调用（含估价）">${formatTokens(embedTokens)}</div>
          <div class="settings-usage-kpi-sub">${embedCalls} 次 · ${formatAmount(embedAmount)}</div>
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
        <h3 class="settings-usage-card-title">类型总量</h3>
        <div class="settings-usage-cats">${catChips}</div>
      </section>

      <section class="settings-usage-card">
        <h3 class="settings-usage-card-title">每日消耗明细</h3>
        <p class="settings-usage-card-hint">按 UTC 日汇总：聊天 Token/次数、生图、生视频、向量（建库+检索）与估价费用</p>
        ${buildDailyBreakdownTable(dailyBreakdown)}
      </section>
    </div>
  `
}

/**
 * @param {HTMLElement} container
 * @param {any} data
 */
function renderModulesView(container, data) {
  container.innerHTML = `
    <div class="settings-usage settings-usage--dash settings-usage--modules">
      ${buildUsageChrome('按模块', '按对话 / 员工 / 工作流 / 知识库查看消耗，可筛选与搜索 · UTC')}
      ${buildModulesPanel(data.byModule)}
    </div>
  `
}

/**
 * @param {HTMLElement} container
 * @param {any} data
 */
function renderBody(container, data) {
  _lastData = data
  if (_view === 'modules') {
    renderModulesView(container, data)
  } else {
    renderOverview(container, data)
  }
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
      api.usageDailyBreakdown({ from, to }),
      api.usageByModule({ from, to, top_n: 40 }).catch(() => null),
    ]
    if (isAdmin) tasks.push(api.usageByPrincipal({ from, to }))
    const results = await Promise.all(tasks)
    const [summary, dailyBySku, byCategory, bySku, dailyBreakdown, byModule] = results
    const byPrincipal = isAdmin ? results[6] : null
    if (!container.isConnected) return
    renderBody(container, {
      summary,
      dailyBySku,
      byCategory,
      bySku,
      dailyBreakdown,
      byModule,
      byPrincipal,
    })
  } catch (e) {
    if (!container.isConnected) return
    _lastData = null
    const msg = String(e?.message || e || '')
    const hint = /404|Not Found|Failed to fetch|Network/i.test(msg)
      ? t('usage.waitingGateway')
      : t('usage.noData')
    container.innerHTML = `
      <div class="settings-usage settings-usage--dash">
        ${buildUsageChrome(t('usage.title'), t('usage.desc'))}
        <div class="settings-usage-empty">${esc(hint)}<br/><span style="font-size:12px;opacity:.7">${esc(msg)}</span></div>
      </div>`
  }
}

/**
 * Re-paint from cache when only view / module filter / search changes.
 * @param {HTMLElement} container
 */
function rerenderFromCache(container) {
  if (_lastData) {
    renderBody(container, _lastData)
    return
  }
  void loadAndRender(container)
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
    const viewBtn = e.target.closest('[data-usage-view]')
    if (viewBtn) {
      e.preventDefault()
      const next = viewBtn.getAttribute('data-usage-view') === 'modules' ? 'modules' : 'overview'
      if (next === _view) return
      _view = next
      rerenderFromCache(container)
      return
    }
    const filterBtn = e.target.closest('[data-usage-module-filter]')
    if (filterBtn) {
      e.preventDefault()
      const next = String(filterBtn.getAttribute('data-usage-module-filter') || 'all')
      if (next === _moduleFilter) return
      _moduleFilter = /** @type {typeof _moduleFilter} */ (next)
      rerenderFromCache(container)
      return
    }
    const daysBtn = e.target.closest('[data-usage-days]')
    if (!daysBtn) return
    const days = Number(daysBtn.getAttribute('data-usage-days')) || 7
    if (days === _periodDays) return
    _periodDays = days
    void loadAndRender(container)
  })
  container.addEventListener('input', (e) => {
    const input = e.target.closest('[data-usage-module-q]')
    if (!input) return
    _moduleQuery = String(/** @type {HTMLInputElement} */ (input).value || '')
    // Keep focus: only refresh the detail table region if possible; full re-render is ok for now.
    const selStart = /** @type {HTMLInputElement} */ (input).selectionStart
    rerenderFromCache(container)
    const again = container.querySelector('[data-usage-module-q]')
    if (again instanceof HTMLInputElement) {
      again.focus()
      const pos = typeof selStart === 'number' ? selStart : again.value.length
      again.setSelectionRange(pos, pos)
    }
  })
  await loadAndRender(container)
}

export function cleanup() {
  _abort?.abort()
  _abort = null
  _lastData = null
  _view = 'overview'
  _moduleFilter = 'all'
  _moduleQuery = ''
}
