/**
 * 系统日志 — 选哪个源就能看哪个全文；异常扫描为辅。
 * 数据优先 Gateway /api/diagnostics；不可用时用 Tauri inspect_log / read_log_tail。
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'

const isTauri = !!window.__TAURI_INTERNALS__

const SOURCE_META = [
  { id: 'gateway', title: 'Gateway', when: '启动失败、后端连不上、任务/模型报错' },
  { id: 'langgraph', title: 'LangGraph', when: '图执行 / Agent 运行时（stderr）' },
  { id: 'frontend', title: 'Frontend', when: '界面 / console' },
  { id: 'startup', title: 'Startup', when: '面板拉起 sidecar' },
  { id: 'plugin-control', title: 'Plugin / Browser', when: '嵌入浏览器 / CDP' },
  { id: 'boot-cycle', title: 'Boot cycle', when: '启动时间线' },
  { id: 'gateway-slow', title: 'Gateway slow', when: '慢请求' },
  { id: 'right-stage', title: 'Right stage', when: '右栏 / 工作流' },
  { id: 'chat-runtime', title: 'Chat runtime', when: '对话起停 / 点发点停 / 左右 busy' },
  { id: 'chat-turn-lifecycle', title: 'Turn lifecycle', when: '点发送→首帧→流结束整轮生命周期' },
  { id: 'assistant-audit', title: 'Assistant audit', when: '助手审计' },
  { id: 'guardian', title: 'Guardian', when: '守护进程' },
  { id: 'config-audit', title: 'Config audit', when: '配置变更审计' },
  { id: 'voice-frontend', title: 'Voice frontend', when: '语音播报前端' },
  { id: 'voice-backend', title: 'Voice backend', when: '语音播报后端' },
]

// Keep in sync with backend admin/diagnostics.py — no bare \b504\b (hits ``.504`` ms stamps).
const ANOMALY_RE =
  /\b(?:ERROR|CRITICAL|FATAL|WARN(?:ING)?)\b|traceback|exception|\bpanic\b|econnrefused|\btimed?\s*out\b|\bfailed\b|HTTP\/1\.[01]"\s+(?:401|403|500|502|503|504)\b/i

const LEVEL_TOKEN_RE =
  /(?:^|\s)-\s*(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\s*-|\[(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\]|^(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL):\s/i

const NOISE_LINE_RE =
  /\[ui_stream\]\s*run_end\s*正文为空|ASR近失|未匹配词表|['"]error['"]\s*:/i

const UVICORN_ACCESS_RE =
  /^INFO:\s+\S+\s+-\s+"[A-Z]+\s+.+\s+HTTP\/1\.[01]"\s+(\d{3})\b/i

const HARD_FAILURE_RE =
  /traceback|exception\b|\bpanic\b|econnrefused|\btimed?\s*out\b|\bfailed\b/i

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
let _sourceFilter = '' // '' = all anomalies; non-empty = raw viewer for that source
let _levelFilter = new Set(['ERROR', 'CRITICAL', 'WARN'])
let _sourcesPayload = null
let _events = []
let _timelineMd = ''
let _mode = 'gateway'
let _loadSeq = 0
let _rawView = null // { path, content, exists, lineCount, hint, title }
let _rawSeq = 0
let _viewMode = 'anomaly' // anomaly | raw

function q(sel) {
  return _pageEl ? _pageEl.querySelector(sel) : null
}

function explicitLevel(line) {
  const m = String(line || '').match(LEVEL_TOKEN_RE)
  if (!m) return null
  const raw = String(m[1] || m[2] || m[3] || '').toUpperCase()
  if (raw === 'WARNING') return 'WARN'
  if (raw === 'FATAL') return 'CRITICAL'
  return raw || null
}

function isNoiseAnomaly(line) {
  const s = String(line || '')
  if (!s.trim()) return true
  if (NOISE_LINE_RE.test(s) && !HARD_FAILURE_RE.test(s)) return true
  const access = s.trim().match(UVICORN_ACCESS_RE)
  if (access) {
    const code = Number(access[1])
    if ([401, 403, 404, 502, 503, 504].includes(code)) return true
  }
  const lvl = explicitLevel(s)
  if ((lvl === 'INFO' || lvl === 'DEBUG') && !HARD_FAILURE_RE.test(s)) return true
  return false
}

function guessLevel(line) {
  const explicit = explicitLevel(line)
  if (explicit === 'CRITICAL' || explicit === 'ERROR' || explicit === 'WARN') return explicit
  if (explicit === 'INFO' || explicit === 'DEBUG') {
    const access = String(line || '')
      .trim()
      .match(UVICORN_ACCESS_RE)
    if (access && Number(access[1]) >= 500) return 'WARN'
    if (HARD_FAILURE_RE.test(line || '')) return 'ERROR'
    return 'WARN'
  }
  const u = String(line || '').toUpperCase()
  if (u.includes('CRITICAL') || u.includes('FATAL')) return 'CRITICAL'
  if (/\bERROR\b/.test(u) && !/['"]error['"]\s*:/i.test(line || '')) return 'ERROR'
  if (/traceback|exception\b/i.test(line || '')) return 'ERROR'
  if (/\bWARN(?:ING)?\b/.test(u)) return 'WARN'
  return 'ERROR'
}

function parseTs(line) {
  const m = String(line || '').match(/(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)/)
  return m ? m[1].replace(' ', 'T') : null
}

async function loadViaGateway() {
  const opts = { silent: true, timeoutMs: 4000 }
  const scanQ = { hours: _hours, limit: 200 }
  if (_sourceFilter) scanQ.sources = _sourceFilter
  const [sources, scan, tl] = await Promise.all([
    api.diagnosticsSources(_hours, opts),
    api.diagnosticsScan(scanQ, opts),
    api.diagnosticsTimeline(
      { hours: _hours, sources: _sourceFilter || undefined, format: 'both', limit: 80 },
      opts,
    ),
  ])
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
  // Parallel inspect — sequential was too slow and tripped route render timeout.
  const results = await Promise.all(
    SOURCE_META.map(async (meta) => {
      let text = ''
      let exists = false
      let path = ''
      try {
        const insp = await api.inspectLog(meta.id, 80)
        text = insp?.content || ''
        exists = !!insp?.exists
        path = insp?.path || ''
      } catch {
        try {
          text = (await api.readLogTail(meta.id, 80)) || ''
          exists = String(text).trim().length > 0
        } catch {
          /* empty */
        }
      }
      return { meta, text, exists, path }
    }),
  )

  const sourcesOut = []
  const events = []
  const withErrors = []

  for (const { meta, text, exists } of results) {
    const lines = String(text)
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter(Boolean)
    const hits = []
    for (const line of lines) {
      if (!ANOMALY_RE.test(line)) continue
      if (isNoiseAnomaly(line)) continue
      const level = guessLevel(line)
      if (level === 'INFO' || level === 'DEBUG') continue
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
    if (hits.length) withErrors.push(meta.id)
    sourcesOut.push({
      id: meta.id,
      title: meta.title,
      when: meta.when,
      exists: exists || lines.length > 0,
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
    timelineMd: '### EvoFlow 异常时间线（本地兜底）\n',
    logsDir: '~/.evoflow/logs',
    withErrors,
  }
}

async function loadRawForSource(sourceId) {
  const seq = ++_rawSeq
  const meta = SOURCE_META.find((m) => m.id === sourceId)
  const title = meta?.title || sourceId
  // Clear stale content immediately so chip switches don't look "stuck" on the previous source.
  _rawView = {
    title,
    path: '',
    exists: false,
    content: '',
    lineCount: 0,
    hint: '',
    loading: true,
  }
  if (_viewMode === 'raw') renderBody()
  try {
    let data = null
    try {
      data = await api.diagnosticsTail(sourceId, 1200, Math.max(_hours, 72), {
        silent: true,
        timeoutMs: 10000,
      })
    } catch {
      data = null
    }
    if ((!data || data.ok === false) && isTauri) {
      const insp = await api.inspectLog(sourceId, 1200)
      data = {
        ok: true,
        exists: !!insp?.exists,
        path: insp?.path || '',
        content: insp?.content || '',
        line_count: insp?.lineCount ?? insp?.line_count ?? 0,
        hint: insp?.exists ? '' : `未找到 ${title} 日志文件`,
        title,
      }
    }
    if (seq !== _rawSeq) return
    _rawView = {
      title: data?.title || title,
      path: data?.path || '',
      exists: !!data?.exists,
      content: data?.content || '',
      lineCount: data?.line_count || data?.lineCount || 0,
      hint: data?.hint || data?.error || '',
      loading: false,
    }
  } catch (e) {
    if (seq !== _rawSeq) return
    _rawView = {
      title,
      path: '',
      exists: false,
      content: '',
      lineCount: 0,
      hint: e?.message || String(e),
      loading: false,
    }
  }
  renderBody()
}

async function refresh() {
  const seq = ++_loadSeq
  const status = q('[data-role="status"]')
  if (status) status.textContent = '加载中…'
  // Paint chips immediately so route doesn't sit blank
  if (!_sourcesPayload) {
    _sourcesPayload = {
      sources: SOURCE_META.map((m) => ({ ...m, exists: true, has_errors: false })),
    }
    renderBody()
  }
  try {
    let data
    if (isTauri) {
      // Desktop: local files first (fast), then optionally enrich via Gateway
      try {
        data = await loadViaTauriFallback()
      } catch (e) {
        try {
          data = await loadViaGateway()
        } catch {
          throw e
        }
      }
      // Soft enrich from Gateway (don't block / don't toast if it fails)
      void loadViaGateway()
        .then((gw) => {
          if (seq !== _loadSeq) return
          if (gw?.sources?.sources?.length) {
            _sourcesPayload = gw.sources
            _events = gw.events || _events
            _timelineMd = gw.timelineMd || _timelineMd
            _mode = 'gateway'
            renderBody()
          }
        })
        .catch(() => {})
    } else {
      data = await loadViaGateway()
    }
    if (seq !== _loadSeq) return
    _mode = data.mode
    _sourcesPayload = data.sources
    _events = data.events || []
    _timelineMd = data.timelineMd || ''
    if (_sourceFilter && _viewMode === 'raw') {
      void loadRawForSource(_sourceFilter)
    } else {
      renderBody()
    }
    if (status) {
      const n = filteredEvents().length
      const errN = (data.withErrors || []).length
      status.textContent =
        `${data.mode === 'gateway' ? '本地/Gateway' : '本地兜底'} · ${data.logsDir || ''} · ` +
        `${errN ? `${errN} 个源有异常` : '暂无异常扫描命中'} · 异常表 ${n} 条`
    }
  } catch (e) {
    if (seq !== _loadSeq) return
    if (status) status.textContent = `加载失败：${e?.message || e}`
    toast(`系统日志加载失败：${e?.message || e}`, 'error')
    renderBody()
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
  const fromApi = _sourcesPayload?.sources
  const list =
    Array.isArray(fromApi) && fromApi.length
      ? fromApi
      : SOURCE_META.map((m) => ({ ...m, has_errors: false, exists: false }))
  // Merge titles for known ids missing from API older builds
  const byId = new Map(list.map((s) => [s.id, s]))
  for (const m of SOURCE_META) {
    if (!byId.has(m.id)) byId.set(m.id, { ...m, exists: false, has_errors: false })
  }
  return [...byId.values()]
    .map((s) => {
      const active = _sourceFilter === s.id ? ' is-active' : ''
      const bad = s.has_errors ? ' has-errors' : ''
      const count = s.error_count ? `<span class="syslog-chip-count">${s.error_count}</span>` : ''
      const miss = s.exists === false ? ' is-missing' : ''
      return `<button type="button" class="syslog-chip${active}${bad}${miss}" data-source="${esc(s.id)}" title="${esc(s.when || '')}">
        <span class="syslog-chip-title">${esc(s.title || s.id)}</span>${count}
      </button>`
    })
    .join('')
}

function renderEvents() {
  const rows = filteredEvents()
  if (!rows.length) {
    return `<div class="syslog-empty">${
      _sourceFilter
        ? '该来源在当前时间窗内没有 ERROR / WARN。可切到「全文」查看完整日志。'
        : '当前筛选下没有 ERROR / WARN。点上方某个日志源可单独查看该源。'
    }</div>`
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

function colorizeRawLine(line) {
  const raw = String(line || '')
  const u = raw.toUpperCase()
  let cls = ''
  if (u.includes('CRITICAL') || u.includes('FATAL')) cls = 'syslog-line--crit'
  else if (u.includes('ERROR') || u.includes('TRACEBACK') || u.includes('EXCEPTION')) cls = 'syslog-line--err'
  else if (/\bWARN(?:ING)?\b/.test(u)) cls = 'syslog-line--warn'
  if (!cls) return esc(raw)
  return `<span class="${cls}">${esc(raw)}</span>`
}

function renderRawPanel() {
  const v = _rawView
  if (!v || v.loading) {
    return `<div class="syslog-empty">正在加载「${esc(v?.title || _sourceFilter || '日志')}」全文…</div>`
  }
  const meta = `<strong>${esc(v.title || '')}</strong> · ${v.exists ? `${v.lineCount} 行` : '无文件'} · <code class="syslog-path">${esc(v.path || '—')}</code>`
  const hint = v.hint
    ? `<div class="syslog-empty" style="margin-bottom:8px;padding:10px;text-align:left">${esc(v.hint)}</div>`
    : ''
  if (!v.exists) {
    return `<div class="syslog-raw-meta">${meta}</div>
      <div class="syslog-empty">${esc(v.hint || '该日志源当前没有文件。进程内 LangGraph 请先重启 Gateway 以生成 langgraph-日期.log；或查看 Gateway。')}</div>`
  }
  const body = String(v.content || '')
    .split(/\r?\n/)
    .map(colorizeRawLine)
    .join('\n')
  return `<div class="syslog-raw-meta">${meta}</div>${hint}
    <pre class="syslog-raw-pre" data-role="raw-pre">${body}</pre>`
}

function renderBody() {
  const chips = q('[data-role="chips"]')
  const events = q('[data-role="events"]')
  const mode = q('[data-role="mode"]')
  const viewToggle = q('[data-role="view-toggle"]')
  if (chips) {
    chips.innerHTML = `
    <button type="button" class="syslog-chip${!_sourceFilter ? ' is-active' : ''}" data-source="">全部（异常）</button>
    ${renderSourceChips()}
  `
  }
  if (viewToggle) {
    viewToggle.innerHTML = _sourceFilter
      ? `<button type="button" class="syslog-level-btn${_viewMode === 'raw' ? ' is-active' : ''}" data-act="set-view" data-view="raw">全文</button>
         <button type="button" class="syslog-level-btn${_viewMode === 'anomaly' ? ' is-active' : ''}" data-act="set-view" data-view="anomaly">仅异常</button>`
      : `<span class="syslog-hint">点选日志源 → 默认看全文；或切「仅异常」</span>`
  }
  if (events) {
    if (_sourceFilter && _viewMode === 'raw') {
      events.innerHTML = renderRawPanel()
      const pre = events.querySelector('[data-role="raw-pre"]')
      if (pre) pre.scrollTop = pre.scrollHeight
    } else {
      events.innerHTML = renderEvents()
    }
  }
  if (mode) mode.textContent = _mode === 'gateway' ? '在线' : '本地兜底'
}

function bind(page) {
  page.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-source]')
    if (chip) {
      e.preventDefault()
      e.stopPropagation()
      const next = chip.getAttribute('data-source') || ''
      // Re-clicking the active source is a no-op (keeps scroll / view mode).
      if (next === _sourceFilter && next) {
        renderBody()
        return
      }
      _sourceFilter = next
      const status = q('[data-role="status"]')
      if (!_sourceFilter) {
        _viewMode = 'anomaly'
        _rawView = null
        if (status) status.textContent = '全部来源 · 异常扫描'
        renderBody()
        return
      }
      // Click a source → show that source's anomalies first (badge counts are actionable).
      // Switch to「全文」for the complete file. Preload raw so the toggle is instant.
      const hasErr = chip.classList.contains('has-errors')
      _viewMode = hasErr ? 'anomaly' : 'raw'
      _rawView = null
      if (status) {
        const title = SOURCE_META.find((m) => m.id === _sourceFilter)?.title || _sourceFilter
        status.textContent =
          _viewMode === 'anomaly'
            ? `来源：${title} · 仅异常（可切「全文」）`
            : `来源：${title} · 加载全文…`
      }
      renderBody()
      void loadRawForSource(_sourceFilter)
      return
    }
    const act = e.target.closest('[data-act]')?.getAttribute('data-act')
    if (!act) return
    if (act === 'refresh') void refresh()
    if (act === 'copy-timeline') void copyTimeline()
    if (act === 'copy-raw') void copyRaw()
    if (act === 'set-view') {
      const v = e.target.closest('[data-act]')?.getAttribute('data-view')
      if (v === 'raw' || v === 'anomaly') {
        _viewMode = v
        if (_viewMode === 'raw' && _sourceFilter) void loadRawForSource(_sourceFilter)
        else renderBody()
      }
      return
    }
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

async function copyRaw() {
  const text = _rawView?.content
  if (!text) {
    toast('暂无全文可复制', 'warn')
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    toast('日志全文已复制', 'success')
  } catch {
    toast('复制失败', 'error')
  }
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
  _viewMode = 'anomaly'
  _rawView = null
  _levelFilter = new Set(['ERROR', 'CRITICAL', 'WARN'])
  page.innerHTML = `
    <div class="page-header syslog-header">
      <div>
        <h1 class="page-title">系统日志</h1>
        <p class="page-desc">点上方芯片切换日志源：有红点数字的先看「仅异常」，再切「全文」· 与 diagnostics.* 同源</p>
      </div>
      <div class="syslog-header-actions">
        <label class="syslog-hours">
          <span class="syslog-hours-label">近</span>
          <select data-role="hours">
            <option value="6">6 小时</option>
            <option value="24" selected>24 小时</option>
            <option value="72">3 天</option>
            <option value="168">7 天</option>
          </select>
        </label>
        <span class="syslog-mode" data-role="mode">—</span>
        <button type="button" class="btn btn-secondary btn-sm" data-act="refresh">刷新</button>
        <button type="button" class="btn btn-secondary btn-sm" data-act="copy-raw">复制全文</button>
        <button type="button" class="btn btn-primary btn-sm" data-act="copy-timeline">复制异常时间线</button>
      </div>
    </div>
    <div class="syslog-toolbar">
      <div class="syslog-levels">
        <button type="button" class="syslog-level-btn is-active" data-act="toggle-level" data-level="ERROR">ERROR</button>
        <button type="button" class="syslog-level-btn is-active" data-act="toggle-level" data-level="WARN">WARN</button>
        <button type="button" class="syslog-level-btn is-active" data-act="toggle-level" data-level="CRITICAL">CRITICAL</button>
      </div>
      <div class="syslog-view-toggle" data-role="view-toggle"></div>
      <div class="syslog-status" data-role="status">准备加载…</div>
    </div>
    <div class="syslog-chips" data-role="chips"></div>
    <div class="syslog-events" data-role="events"></div>
  `
  bind(page)
  // Must return shell immediately — awaiting diagnostics here caused「页面渲染超时」.
  renderBody()
  void refresh()
  return page
}

export function cleanup() {
  _pageEl = null
  _sourcesPayload = null
  _events = []
  _timelineMd = ''
  _rawView = null
}
