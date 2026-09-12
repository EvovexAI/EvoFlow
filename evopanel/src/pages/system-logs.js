/**
 * 系统日志 — 专业运维模块
 * 数据优先 Gateway /api/diagnostics（与 platform diagnostics.* 同源）；
 * Gateway 不可用时用 Tauri read_log_tail / search_log 兜底。
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'

const isTauri = !!window.__TAURI_INTERNALS__

const SOURCE_META = [
  { id: 'gateway', title: 'Gateway', when: '启动失败、后端连不上、任务/模型报错' },
  { id: 'langgraph', title: 'LangGraph', when: '图执行 / Agent 运行时' },
  { id: 'frontend', title: 'Frontend', when: '界面 / console' },
  { id: 'startup', title: 'Startup', when: '面板拉起 sidecar' },
  { id: 'guardian', title: 'Guardian', when: '守护进程' },
  { id: 'config-audit', title: 'Config audit', when: '配置变更审计' },
]

const ANOMALY_RE =
  /\b(?:ERROR|CRITICAL|FATAL|WARN(?:ING)?)\b|traceback|exception|\bpanic\b|econnrefused|\btimed?\s*out\b|\bfailed\b|\b(?:401|403|500|502|503|504)\b/i

const esc = (s) =>
  !s
    ? ''
    : String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')

let _pageEl = null
let _hours = 24
let _sourceFilter = '' // '' = all with preference to error sources
let _levelFilter = new Set(['ERROR', 'CRITICAL', 'WARN'])
let _sourcesPayload = null
let _events = []
let _timelineMd = ''
let _mode = 'gateway' // gateway | tauri-fallback
let _loadSeq = 0

function q(sel) {
  return _pageEl ? _pageEl.querySelector(sel) : null
}

function guessLevel(line) {
  const u = String(line || '').toUpperCase()
  if (u.includes('CRITICAL') || u.includes('FATAL')) return 'CRITICAL'
  if (u.includes('ERROR') || u.includes('TRACEBACK') || u.includes('EXCEPTION')) return 'ERROR'
  if (/\bWARN(?:ING)?\b/.test(u)) return 'WARN'
  return 'ERROR'
}

function parseTs(line) {
  const m = String(line || '').match(/(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)/)
  return m ? m[1].replace(' ', 'T') : null
}

async function loadViaGateway() {
  const sources = await api.diagnosticsSources(_hours, { silent: true, timeoutMs: 8000 })
  const scanQ = { hours: _hours, limit: 300 }
  if (_sourceFilter) scanQ.sources = _sourceFilter
  const scan = await api.diagnosticsScan(scanQ, { silent: true, timeoutMs: 12000 })
  const tl = await api.diagnosticsTimeline(
    { hours: _hours, sources: _sourceFilter || undefined, format: 'both', limit: 80 },
    { silent: true, timeoutMs: 12000 },
  )
  return {
    mode: 'gateway',
    sources,
    events: Array.isArray(scan?.events) ? scan.events : [],
    timelineMd: String(tl?.markdown || ''),
    logsDir: sources?.logs_dir || scan?.logs_dir || '',
    withErrors: sources?.sources_with_errors || scan?.sources_with_errors || [],
  }
}

async function loadViaTauriFallback() {
  const sourcesOut = []
  const events = []
  const withErrors = []

  for (const meta of SOURCE_META) {
    let text = ''
    try {
      text = (await api.readLogTail(meta.id, 400)) || ''
    } catch {
      text = ''
    }
    const lines = String(text)
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter(Boolean)
    const hits = []
    for (const line of lines) {
      if (!ANOMALY_RE.test(line)) continue
      const level = guessLevel(line)
      const summary = line.length > 180 ? `${line.slice(0, 177)}…` : line
      hits.push({
        ts: parseTs(line),
        level,
        summary,
        source: meta.id,
        source_title: meta.title,
        file: meta.id,
        count: 1,
      })
    }
    const exists = lines.length > 0
    if (hits.length) withErrors.push(meta.id)
    sourcesOut.push({
      id: meta.id,
      title: meta.title,
      when: meta.when,
      exists,
      has_errors: hits.length > 0,
      error_count: hits.length,
      latest_error_at: hits.length ? hits[hits.length - 1].ts : null,
      sample: hits.length ? hits[hits.length - 1].summary : null,
      files: [],
    })
    for (const h of hits.reverse()) {
      if (_sourceFilter && h.source !== _sourceFilter) continue
      events.push(h)
    }
  }

  const mdLines = [
    '### EvoFlow 异常时间线',
    `- 范围：最近（Tauri 兜底，约末尾若干行）`,
    `- 模式：桌面兜底（Gateway 不可用）`,
    `- 有报错的源：${withErrors.length ? withErrors.join(', ') : '无'}`,
    '',
    '| 时间 | 来源 | 级别 | 摘要 |',
    '|---|---|---|---|',
  ]
  for (const ev of events.slice(0, 80)) {
    mdLines.push(
      `| ${ev.ts || '—'} | ${ev.source} | ${ev.level} | ${String(ev.summary || '').replace(/\|/g, '\\|')} |`,
    )
  }
  if (!events.length) mdLines.push('| — | — | — | 未匹配到异常行 |')

  return {
    mode: 'tauri-fallback',
    sources: {
      ok: true,
      logs_dir: '~/.evoflow/logs',
      hours: _hours,
      sources: sourcesOut,
      sources_with_errors: withErrors,
      error_source_count: withErrors.length,
    },
    events,
    timelineMd: mdLines.join('\n'),
    logsDir: '~/.evoflow/logs',
    withErrors,
  }
}

async function refresh() {
  const seq = ++_loadSeq
  const status = q('[data-role="status"]')
  if (status) status.textContent = '加载中…'
  try {
    let data
    try {
      data = await loadViaGateway()
    } catch (e) {
      if (!isTauri) throw e
      data = await loadViaTauriFallback()
      toast('Gateway 不可用，已用本地日志兜底', 'warn')
    }
    if (seq !== _loadSeq) return
    _mode = data.mode
    _sourcesPayload = data.sources
    _events = data.events || []
    _timelineMd = data.timelineMd || ''
    renderBody()
    if (status) {
      const n = filteredEvents().length
      const errN = (data.withErrors || []).length
      status.textContent =
        `${data.mode === 'gateway' ? 'Gateway' : '本地兜底'} · ${data.logsDir || ''} · ` +
        `${errN ? `${errN} 个源有异常` : '暂无异常'} · 展示 ${n} 条`
    }
  } catch (e) {
    if (seq !== _loadSeq) return
    if (status) status.textContent = `加载失败：${e?.message || e}`
    toast(`系统日志加载失败：${e?.message || e}`, 'error')
  }
}

function filteredEvents() {
  return (_events || []).filter((ev) => {
    if (_sourceFilter && ev.source !== _sourceFilter) return false
    const lv = String(ev.level || 'ERROR').toUpperCase()
    if (_levelFilter.size && !_levelFilter.has(lv)) {
      if (lv === 'WARNING' && _levelFilter.has('WARN')) return true
      return false
    }
    return true
  })
}

function renderSourceChips() {
  const list = _sourcesPayload?.sources || SOURCE_META.map((m) => ({ ...m, has_errors: false, exists: false }))
  return list
    .map((s) => {
      const active = _sourceFilter === s.id ? ' is-active' : ''
      const bad = s.has_errors ? ' has-errors' : ''
      const count = s.error_count ? `<span class="syslog-chip-count">${s.error_count}</span>` : ''
      const miss = !s.exists ? ' is-missing' : ''
      return `<button type="button" class="syslog-chip${active}${bad}${miss}" data-source="${esc(s.id)}" title="${esc(s.when || '')}">
        <span class="syslog-chip-title">${esc(s.title || s.id)}</span>${count}
      </button>`
    })
    .join('')
}

function renderEvents() {
  const rows = filteredEvents()
  if (!rows.length) {
    return `<div class="syslog-empty">当前筛选下没有 ERROR / WARN 记录。可换时间窗、换日志源，或点「刷新」。</div>`
  }
  return `<div class="syslog-table-wrap"><table class="syslog-table">
    <thead><tr><th>时间</th><th>来源</th><th>级别</th><th>次数</th><th>摘要</th></tr></thead>
    <tbody>${rows
      .map((ev) => {
        const lv = String(ev.level || 'ERROR').toUpperCase()
        const tone = lv === 'WARN' || lv === 'WARNING' ? 'warn' : lv === 'CRITICAL' || lv === 'FATAL' ? 'crit' : 'err'
        const count = ev.count || 1
        let ts = ev.ts || '—'
        if (ev.last_ts && ev.last_ts !== ev.ts && count > 1) ts = `${ts} ~ ${ev.last_ts}`
        return `<tr class="syslog-row syslog-row--${tone}">
          <td class="syslog-td-ts">${esc(ts)}</td>
          <td>${esc(ev.source)}</td>
          <td><span class="syslog-level syslog-level--${tone}">${esc(lv)}</span></td>
          <td>${esc(count)}</td>
          <td class="syslog-td-sum">${esc(ev.summary)}</td>
        </tr>`
      })
      .join('')}</tbody>
  </table></div>`
}

function renderBody() {
  const chips = q('[data-role="chips"]')
  const events = q('[data-role="events"]')
  const mode = q('[data-role="mode"]')
  if (chips) chips.innerHTML = `
    <button type="button" class="syslog-chip${!_sourceFilter ? ' is-active' : ''}" data-source="">全部</button>
    ${renderSourceChips()}
  `
  if (events) events.innerHTML = renderEvents()
  if (mode) mode.textContent = _mode === 'gateway' ? '在线' : '本地兜底'
}

function bind(page) {
  page.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-source]')
    if (chip) {
      _sourceFilter = chip.getAttribute('data-source') || ''
      renderBody()
      return
    }
    const act = e.target.closest('[data-act]')?.getAttribute('data-act')
    if (!act) return
    if (act === 'refresh') void refresh()
    if (act === 'copy-timeline') void copyTimeline()
    if (act === 'toggle-level') {
      const lv = e.target.closest('[data-act]')?.getAttribute('data-level')
      if (!lv) return
      if (_levelFilter.has(lv)) _levelFilter.delete(lv)
      else _levelFilter.add(lv)
      page.querySelectorAll('[data-act="toggle-level"]').forEach((btn) => {
        const l = btn.getAttribute('data-level')
        btn.classList.toggle('is-active', _levelFilter.has(l))
      })
      renderBody()
    }
  })
  page.querySelector('[data-role="hours"]')?.addEventListener('change', (e) => {
    _hours = Math.max(1, Number(e.target.value) || 24)
    void refresh()
  })
}

async function copyTimeline() {
  let md = _timelineMd
  if (!md) {
    try {
      const tl = await api.diagnosticsTimeline({
        hours: _hours,
        sources: _sourceFilter || undefined,
        format: 'markdown',
      })
      md = tl?.markdown || ''
    } catch {
      /* keep empty */
    }
  }
  if (!md) {
    toast('暂无可复制的时间线', 'warn')
    return
  }
  try {
    await navigator.clipboard.writeText(md)
    toast('异常时间线已复制', 'success')
  } catch {
    toast('复制失败，请手动选择', 'error')
  }
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page syslog-page'
  _pageEl = page
  _sourceFilter = ''
  _levelFilter = new Set(['ERROR', 'CRITICAL', 'WARN'])
  page.innerHTML = `
    <div class="page-header syslog-header">
      <div>
        <h1 class="page-title">系统日志</h1>
        <p class="page-desc">ERROR / WARN / 异常扫描 · 与助手 <code>diagnostics.*</code> 同源 · 可导出异常时间线</p>
      </div>
      <div class="syslog-header-actions">
        <label class="syslog-hours">近
          <select data-role="hours">
            <option value="6">6 小时</option>
            <option value="24" selected>24 小时</option>
            <option value="72">3 天</option>
            <option value="168">7 天</option>
          </select>
        </label>
        <span class="syslog-mode" data-role="mode">—</span>
        <button type="button" class="btn btn-secondary btn-sm" data-act="refresh">刷新</button>
        <button type="button" class="btn btn-primary btn-sm" data-act="copy-timeline">复制异常时间线</button>
      </div>
    </div>
    <div class="syslog-toolbar">
      <div class="syslog-levels">
        <button type="button" class="syslog-level-btn is-active" data-act="toggle-level" data-level="ERROR">ERROR</button>
        <button type="button" class="syslog-level-btn is-active" data-act="toggle-level" data-level="WARN">WARN</button>
        <button type="button" class="syslog-level-btn is-active" data-act="toggle-level" data-level="CRITICAL">CRITICAL</button>
      </div>
      <div class="syslog-status" data-role="status">准备加载…</div>
    </div>
    <div class="syslog-chips" data-role="chips"></div>
    <div class="syslog-events" data-role="events"></div>
  `
  bind(page)
  await refresh()
  return page
}

export function cleanup() {
  _pageEl = null
  _sourcesPayload = null
  _events = []
  _timelineMd = ''
}
