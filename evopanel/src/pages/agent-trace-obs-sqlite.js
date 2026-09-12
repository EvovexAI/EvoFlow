/**
 * SQLite observability UI (Gateway /api/observability/*).
 */

import { toast } from '../components/toast.js'
import { api } from '../lib/tauri-api.js'
import {
  fmtMs,
  fmtNum,
  fmtPct,
  getObsTimeRangeLabel,
  obsQueryParams,
  renderObsBarChart,
  renderObsHero,
  renderObsSectionCard,
  renderObsStatCards,
  renderObsTable,
  obsActionBtn,
  obsStatusTag,
  obsTableActions,
  obsCellMono,
  obsCellLink,
  renderObsFilterField,
  renderObsFilterForm,
  bindObsPagination,
  renderObsKpiGrid,
  renderObsElmCard,
  renderObsTrendCharts,
  obsDaysParam,
} from '../lib/obs-dashboard-ui.js'
import {
  installAgentTraceJsonModalDelegate,
  openAgentTraceJsonModal,
  peekStashedPayload,
  stashJsonForModal,
} from './agent-trace-json-modal.js'
import {
  installAgentTraceSystemPromptDelegate,
  openAgentTraceSystemPromptModal,
  resolveSystemPromptFromRequestJson,
  stashSystemPromptForModal,
} from './agent-trace-system-prompt.js'
import { formatDurationSec } from './agent-trace-format.js'
import {
  formatInvocationKindLabel,
  invocationKindFilterOptions,
} from './agent-trace-invocation-kinds.js'
import {
  formatCompressPassLabel,
  formatModelInputTokensWithCompaction,
  formatCacheHitTokens,
} from './agent-trace-compaction.js'
import {
  renderModelResponsePreviewCell,
  renderModelResponseTypeCell,
  summarizeModelResponse,
} from './agent-trace-model-response.js'

let _obsEnabled = null

export function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function trunc(s, n = 20) {
  const t = String(s || '')
  return t.length > n ? t.slice(0, n) + '…' : t
}

function formatIso(v) {
  if (v == null || v === '') return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleString()
}

function statusTag(status) {
  return obsStatusTag(status)
}

let _obsStatusInflight = /** @type {Promise<boolean> | null} */ (null)

export async function isObservabilityEnabled() {
  if (_obsEnabled !== null) return _obsEnabled
  if (_obsStatusInflight) return _obsStatusInflight
  _obsStatusInflight = (async () => {
    try {
      const st = await api.observabilityStatus({ silent: true, timeoutMs: 8000 })
      _obsEnabled = !!st?.enabled
    } catch {
      _obsEnabled = false
    }
    return _obsEnabled
  })().finally(() => {
    _obsStatusInflight = null
  })
  return _obsStatusInflight
}

export function resetObservabilityCache() {
  _obsEnabled = null
  _obsStatusInflight = null
}

function statCard(title, value, descHtml) {
  return `<div class="el-obs-stat-card">
      <div class="el-obs-stat-card__label">${escHtml(title)}</div>
      <div class="el-obs-stat-card__value">${escHtml(String(value))}</div>
      <div class="el-obs-stat-card__footer">${descHtml}</div>
    </div>`
}

function _timeQ() {
  return obsQueryParams()
}

function bindThreadLinks(root, onPickThread) {
  root?.querySelectorAll('[data-thread-id], .obs-cell-link[data-thread-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const tid = el.getAttribute('data-thread-id')
      if (tid && onPickThread) onPickThread(tid)
    })
  })
}

function renderPaginationBar(container, meta, onPage) {
  bindObsPagination(container, meta, onPage)
}

function parseMaybeJsonField(s) {
  if (s == null || s === '') return null
  const t = String(s)
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

function clipboardTextFromPayload(payload) {
  if (payload == null) return ''
  if (typeof payload === 'string') return payload
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}

/** @param {Record<string, unknown>} row SQLite tool row */
function buildToolErrorClipboardText(row) {
  const msg = row.error_message != null ? String(row.error_message) : ''
  const out = row.output_text != null ? String(row.output_text) : ''
  const body = msg || out
  const head = `[${String(row.tool_name || '?')}] ${String(row.error_type || 'error')}`
  return body.startsWith(head) ? body : `${head}\n\n${body}`.trim()
}

/** @param {HTMLElement | null} table */
function ensureToolObsTableActionsBound(table) {
  if (!table || table.dataset.obsToolActionsBound === '1') return
  table.dataset.obsToolActionsBound = '1'
  table.addEventListener('click', async (ev) => {
    const cp = /** @type {HTMLElement | null} */ (ev.target.closest('.el-obs-tool-copy-err'))
    if (!cp) return
    ev.preventDefault()
    const sid = cp.getAttribute('data-stash-copy')
    const raw = sid ? peekStashedPayload(sid) : undefined
    const text = clipboardTextFromPayload(raw)
    if (!text) {
      toast('\u65e0\u53ef\u590d\u5236\u5185\u5bb9', 'warning')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      toast('\u5df2\u590d\u5236\u5230\u526a\u8d34\u677f', 'success')
    } catch {
      toast('\u590d\u5236\u5931\u8d25\uff08\u6743\u9650\u6216\u6d4f\u89c8\u5668\u9650\u5236\uff09', 'error')
    }
  })
}

function filterFormHtml(fields) {
  return renderObsFilterForm(fields)
}

function obsFilterInput(name, extra = '') {
  return `<input class="form-input obs-filter-input" name="${escHtml(name)}" ${extra} />`
}

function obsFilterSelect(name, optionsHtml) {
  return `<select class="form-input obs-filter-select" name="${escHtml(name)}">${optionsHtml}</select>`
}

export async function renderOverviewFromSqlite(page, { onPickThread } = {}) {
  const statsGrid = page.querySelector('#at-stats-grid')
  const recentActivityList = page.querySelector('#at-recent-activity-list')
  const q = _timeQ()
  const daysQ = obsDaysParam()
  const [ov, trends] = await Promise.all([
    api.observabilityOverview(q),
    api.observabilityTrends(daysQ).catch(() => null),
  ])
  const tok = ov.total_tokens || {}
  const totalTok = typeof tok === 'object' ? tok.total || 0 : tok

  statsGrid.innerHTML = `
    ${renderObsKpiGrid([
      {
        label: '工具调用',
        value: fmtNum(ov.tool_invocations),
        footer: `错误率 ${fmtPct(ov.tool_error_rate)} · ${getObsTimeRangeLabel()}`,
      },
      {
        label: '模型请求',
        value: fmtNum(ov.model_invocations),
        footer: `P95 ${fmtMs(ov.model_latency_p95_ms)}`,
      },
      {
        label: 'Token 累计',
        value: fmtNum(totalTok),
        footer: `入 ${fmtNum(tok.input || 0)} / 出 ${fmtNum(tok.output || 0)}`,
      },
      {
        label: '首 Token P95',
        value: fmtMs(ov.model_ttft_p95_ms),
        footer: `会话 ${fmtNum(ov.thread_count)}`,
      },
    ])}
    ${renderObsTrendCharts(trends, getObsTimeRangeLabel())}`

  const slowTools = ov.top_slow_tools || []
  const slowThreads = ov.top_slow_threads || []
  const modelTok = ov.model_token_stats || []

  const tokenChart =
    modelTok.length > 0
      ? renderObsSectionCard({
          title: '各模型 Token 分布',
          subtitle: getObsTimeRangeLabel(),
          bodyHtml: renderObsBarChart({
            items: modelTok.slice(0, 10).map((r) => ({
              label: trunc(String(r.model || '?'), 8),
              value: Number(r.total_tokens || 0),
            })),
            color: '#22c55e',
          }),
        })
      : ''

  recentActivityList.innerHTML = `
    ${tokenChart}
    ${renderObsSectionCard({
      title: '耗时最多的工具（Top 10）',
      bodyHtml: renderObsTable(
        ['工具', '次数', '平均耗时', '最大耗时', '错误'],
        slowTools.map((r) => `<tr>
          <td class="task-obs-table-name">${escHtml(r.tool_name)}</td>
          <td class="task-obs-table-num">${r.call_count}</td>
          <td class="task-obs-table-num">${formatDurationSec(r.avg_duration_ms)}</td>
          <td class="task-obs-table-num">${formatDurationSec(r.max_duration_ms)}</td>
          <td class="task-obs-table-num">${r.error_count || 0}</td>
        </tr>`).join(''),
        { emptyColspan: 5, wrapPanel: false },
      ),
    })}
    ${renderObsSectionCard({
      title: '各模型 Token 统计',
      bodyHtml: renderObsTable(
        ['模型', '请求次数', '输入 Token', '输出 Token', '合计'],
        modelTok.map((r) => `<tr>
          <td class="task-obs-table-model">${escHtml(r.model || '—')}</td>
          <td class="task-obs-table-num">${r.invocations ?? 0}</td>
          <td class="task-obs-table-tokens">${r.input_tokens ?? 0}</td>
          <td class="task-obs-table-tokens">${r.output_tokens ?? 0}</td>
          <td class="task-obs-table-tokens">${r.total_tokens ?? 0}</td>
        </tr>`).join(''),
        { emptyColspan: 5, wrapPanel: false },
      ),
    })}
    ${renderObsSectionCard({
      title: '工具耗时最多的 Thread（Top 10）',
      bodyHtml: renderObsTable(
        ['Thread', '次数', '总耗时', '最大单次'],
        slowThreads.map((r) => `<tr>
          <td>${obsCellLink(trunc(r.thread_id, 24), r.thread_id, r.thread_id)}</td>
          <td class="task-obs-table-num">${r.tool_calls}</td>
          <td class="task-obs-table-num">${Math.round(r.total_tool_ms || 0)}ms</td>
          <td class="task-obs-table-num">${Math.round(r.max_tool_ms || 0)}ms</td>
        </tr>`).join(''),
        { emptyColspan: 4, wrapPanel: false },
      ),
    })}`
  bindThreadLinks(recentActivityList, onPickThread)
}

const gatewayState = { page: 1, filters: {} }
const toolsState = { page: 1, filters: {} }
const modelsState = { page: 1, filters: {} }

function bindFilterForm(filterWrap, state, reload) {
  if (!filterWrap || filterWrap.dataset.bound) return
  filterWrap.dataset.bound = '1'
  const form = filterWrap.querySelector('form')
  if (!form) return
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const fd = new FormData(form)
    state.filters = Object.fromEntries(
      [...fd.entries()].map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v),
    )
    state.page = 1
    reload()
  })
  form.querySelector('[data-reset]')?.addEventListener('click', () => {
    form.reset()
    state.filters = {}
    state.page = 1
    reload()
  })
}

export async function renderGatewayRequestsFromSqlite(page) {
  installAgentTraceJsonModalDelegate()
  const statsEl = page.querySelector('#at-gateway-stats')
  const tableBody = page.querySelector('#at-gateway-table-body')
  const filterWrap = page.querySelector('#at-gateway-filter-wrap')
  const paginationEl = page.querySelector('#at-gateway-pagination')

  if (filterWrap && !filterWrap.dataset.html) {
    filterWrap.dataset.html = '1'
    filterWrap.innerHTML = filterFormHtml(`
      ${renderObsFilterField('路径', obsFilterInput('path', 'style="min-width:220px"'))}
      ${renderObsFilterField('方法', obsFilterSelect('method', '<option value="">全部</option><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option>'))}
      ${renderObsFilterField('状态', obsFilterSelect('status_family', '<option value="">全部</option><option value="2xx">2xx</option><option value="3xx">3xx</option><option value="4xx">4xx</option><option value="5xx">5xx</option>'))}
      ${renderObsFilterField('最小耗时(ms)', obsFilterInput('min_duration_ms', 'type="number" min="0" style="width:120px"'))}`)
  }
  bindFilterForm(filterWrap, gatewayState, () => void renderGatewayRequestsFromSqlite(page))

  const q = _timeQ()
  const daysQ = obsDaysParam()
  const [summary, data, trends] = await Promise.all([
    api.observabilityGatewayRequestSummary(q),
    api.observabilityGatewayRequests({ page: gatewayState.page, page_size: 20, ...q, ...gatewayState.filters }),
    api.observabilityTrends(daysQ).catch(() => null),
  ])
  const items = data.items || []
  statsEl.innerHTML = `
    ${renderObsKpiGrid([
      { label: '请求总数', value: fmtNum(summary.request_count ?? 0), footer: `错误 ${fmtNum(summary.error_count ?? 0)}` },
      { label: '错误率', value: fmtPct(summary.error_rate || 0), footer: getObsTimeRangeLabel() },
      { label: '平均耗时', value: fmtMs(summary.avg_duration_ms), footer: `最大 ${fmtMs(summary.max_duration_ms)}` },
      { label: '当前页', value: `${items.length}/${data.total || 0}`, footer: '分页记录' },
    ])}
    ${renderObsTrendCharts(trends, getObsTimeRangeLabel())}`

  if (!items.length) {
    tableBody.innerHTML = '<tr class="task-obs-table-row is-empty"><td colspan="9">暂无记录</td></tr>'
  } else {
    tableBody.innerHTML = items.map((row, i) => {
      const reqHeaders = parseMaybeJsonField(row.request_headers_json)
      const respHeaders = parseMaybeJsonField(row.response_headers_json)
      const metadata = parseMaybeJsonField(row.metadata_json)
      const detailId = stashJsonForModal({
        id: row.id,
        occurred_at: row.occurred_at,
        method: row.method,
        path: row.path,
        query_string: row.query_string,
        client_ip: row.client_ip,
        user_agent: row.user_agent,
        status_code: row.status_code,
        duration_ms: row.duration_ms,
        request: {
          content_type: row.request_content_type,
          headers: reqHeaders,
          body_sample: row.request_body_sample,
          truncated: !!row.request_body_truncated,
        },
        response: {
          content_type: row.response_content_type,
          headers: respHeaders,
          body_sample: row.response_body_sample,
          truncated: !!row.response_body_truncated,
        },
        error_type: row.error_type,
        metadata,
      })
      const status = Number(row.status_code || 0)
      return `<tr>
        <td class="task-obs-table-num">${(data.page - 1) * data.page_size + i + 1}</td>
        <td>${escHtml(formatIso(row.occurred_at))}</td>
        <td>${obsCellMono(row.method || '—')}</td>
        <td class="task-obs-table-name" title="${escHtml(row.path || '')}">${escHtml(trunc(row.path || '—', 64))}</td>
        <td>${statusTag(status ? String(status) : '—')}</td>
        <td class="task-obs-table-num">${row.duration_ms != null ? Math.round(row.duration_ms) + 'ms' : '—'}</td>
        <td>${obsCellMono(row.client_ip || '—')}</td>
        <td>${escHtml(trunc(row.response_content_type || row.request_content_type || '—', 28))}</td>
        <td>${obsTableActions(obsActionBtn('查看', 'secondary', `data-json-ref="${detailId}" data-json-title="Gateway 请求详情"`, 'agent-trace-json-modal-open'))}</td>
      </tr>`
    }).join('')
  }
  renderPaginationBar(paginationEl, data, (p) => {
    gatewayState.page = p
    void renderGatewayRequestsFromSqlite(page)
  })
}

export async function renderToolsFromSqlite(page, { onPickThread } = {}) {
  installAgentTraceJsonModalDelegate()
  const toolsStatsEl = page.querySelector('#at-tools-stats')
  const toolsTableBody = page.querySelector('#at-tools-table-body')
  const filterWrap = page.querySelector('#at-tools-filter-wrap')
  const paginationEl = page.querySelector('#at-tools-pagination')

  if (filterWrap && !filterWrap.dataset.html) {
    filterWrap.dataset.html = '1'
    filterWrap.innerHTML = filterFormHtml(`
      ${renderObsFilterField('Thread ID', obsFilterInput('thread_id', 'style="min-width:220px"'))}
      ${renderObsFilterField('工具名', obsFilterInput('tool_name'))}
      ${renderObsFilterField('状态', obsFilterSelect('status', '<option value="">全部</option><option value="success">success</option><option value="error">error</option>'))}`)
  }
  bindFilterForm(filterWrap, toolsState, () => void renderToolsFromSqlite(page, { onPickThread }))

  const q = _timeQ()
  const daysQ = obsDaysParam()
  const [ov, data, trends] = await Promise.all([
    api.observabilityOverview(q).catch(() => ({})),
    api.observabilityTools({ page: toolsState.page, page_size: 20, ...q, ...toolsState.filters }),
    api.observabilityTrends(daysQ).catch(() => null),
  ])
  const items = data.items || []
  const pageErrors = items.filter((r) => r.status === 'error').length
  toolsStatsEl.innerHTML = `
    ${renderObsKpiGrid([
      { label: '筛选范围内', value: fmtNum(data.total || ov.tool_invocations || 0), footer: `本页 ${items.length} 条` },
      { label: '总错误率', value: fmtPct(ov.tool_error_rate), footer: `本页错误 ${pageErrors}` },
      { label: '平均耗时', value: fmtMs(ov.tool_avg_duration_ms), footer: getObsTimeRangeLabel() },
    ])}
    ${renderObsTrendCharts(trends, getObsTimeRangeLabel())}
    <p class="obs-list-hint">工具调用明细 · ${getObsTimeRangeLabel()}</p>`

  if (!items.length) {
    toolsTableBody.innerHTML = '<tr class="task-obs-table-row is-empty"><td colspan="8">暂无记录</td></tr>'
  } else {
    toolsTableBody.innerHTML = items.map((row, i) => {
      const err = row.status === 'error'
      const previewSrc = String((err ? row.error_message || row.output_text : '') || '')
      const errHtml = err
        ? `<div class="obs-error-cell">
             <div class="obs-error-cell__type">${escHtml(row.error_type || 'Error')}</div>
             <div class="obs-error-cell__preview">${escHtml(trunc(previewSrc, 360))}</div>
           </div>`
        : '—'

      const parsedIn = parseMaybeJsonField(row.input_json)
      const detailPayload = err
        ? {
            tool_name: row.tool_name,
            thread_id: row.thread_id,
            tool_call_id: row.tool_call_id,
            ended_at: row.ended_at,
            duration_ms: row.duration_ms,
            status: row.status,
            input: parsedIn,
            output_text: row.output_text,
            error: {
              type: row.error_type,
              message: row.error_message,
              detail: parseMaybeJsonField(row.error_detail_json),
            },
          }
        : { tool_name: row.tool_name, input: parsedIn, output_text: row.output_text }

      const detailId = stashJsonForModal(detailPayload)
      const modalTitle = err ? `\u5de5\u5177\u8bb0\u5f55 #${(data.page - 1) * data.page_size + i + 1}\uff08\u542b\u5b8c\u6574\u62a5\u9519\uff09` : `\u5de5\u5177 I/O #${(data.page - 1) * data.page_size + i + 1}`
      const copyId = err ? stashJsonForModal(buildToolErrorClipboardText(row)) : ''

      const copyBtn = err
        ? obsActionBtn('复制报错', 'ghost', `data-stash-copy="${copyId}"`, 'el-obs-tool-copy-err')
        : ''
      const viewBtn = obsActionBtn(
        err ? '查看完整' : '查看 JSON',
        'secondary',
        `data-json-ref="${detailId}" data-json-title="${escHtml(modalTitle)}"`,
        'agent-trace-json-modal-open',
      )
      return `<tr>
          <td class="task-obs-table-num">${(data.page - 1) * data.page_size + i + 1}</td>
          <td>${escHtml(formatIso(row.ended_at))}</td>
          <td class="task-obs-table-name">${escHtml(row.tool_name)}</td>
          <td>${statusTag(row.status)}</td>
          <td class="task-obs-table-num">${row.duration_ms != null ? Math.round(row.duration_ms) + 'ms' : '—'}</td>
          <td>${obsCellLink(trunc(row.thread_id, 18), row.thread_id, row.thread_id)}</td>
          <td>${errHtml}</td>
          <td>${obsTableActions(`${viewBtn}${copyBtn}`)}</td>
        </tr>`
    }).join('')
  }
  bindThreadLinks(page.querySelector('#at-tools-table'), onPickThread)
  ensureToolObsTableActionsBound(page.querySelector('#at-tools-table'))
  renderPaginationBar(paginationEl, data, (p) => {
    toolsState.page = p
    void renderToolsFromSqlite(page, { onPickThread })
  })
}

function formatObsUsageTok(v) {
  if (v == null || v === '') return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return String(Math.round(n))
}

/** Parse a JSON field that may be null/string/object. */
function parseJsonField(raw) {
  if (raw == null || raw === '') return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(String(raw))
  } catch {
    return String(raw)
  }
}

/**
 * Click delegate for on-demand model detail loading.
 * Buttons with ``data-model-detail-id`` fetch the full row from the detail endpoint.
 */
function installModelDetailDelegate() {
  if (window._modelDetailInstalled) return
  window._modelDetailInstalled = true
  document.body.addEventListener('click', async (e) => {
    const btn = /** @type {HTMLElement | null} */ (e.target.closest('[data-model-detail-id]'))
    if (!btn) return
    e.preventDefault()
    const rowId = btn.getAttribute('data-model-detail-id')
    const field = btn.getAttribute('data-model-detail-field') || 'request_json'
    const title = btn.getAttribute('data-json-title') || '模型详情'
    const isSysPrompt = btn.getAttribute('data-model-detail-sys-prompt') === '1'
    if (!rowId) return

    const origText = btn.textContent
    btn.disabled = true
    btn.textContent = '加载中…'
    try {
      const detail = await api.observabilityModelDetail(rowId)
      if (!detail) {
        toast('未找到记录', 'warning')
        return
      }
      if (isSysPrompt) {
        const reqObj = parseJsonField(detail.request_json)
        const sysPrompt = resolveSystemPromptFromRequestJson(reqObj)
        if (!sysPrompt.segments.length) {
          toast('无系统提示词', 'warning')
          return
        }
        openAgentTraceSystemPromptModal(title, sysPrompt)
      } else {
        let payload = detail[field]
        if (field === 'request_json' || field === 'response_json' || field === 'usage_json') {
          payload = parseJsonField(payload)
        }
        if (payload == null) {
          toast('无数据', 'warning')
          return
        }
        openAgentTraceJsonModal(title, payload)
      }
    } catch (err) {
      toast(`加载失败: ${String(err?.message || err)}`, 'error')
    } finally {
      btn.disabled = false
      btn.textContent = origText
    }
  })
}

/**
 * Convert backend ``response_summary`` (from ``_summarize_response_for_list``)
 * to the frontend ``ModelResponseSummary`` shape.
 * @param {Record<string, unknown>} bs
 * @returns {import('./agent-trace-model-response.js').ModelResponseSummary}
 */
function responseSummaryFromBackend(bs) {
  const kind = String(bs.kind || 'empty')
  const kindLabelZh = String(bs.kind_label_zh || '—')
  const kindLabelEn = String(bs.kind_label_en || '—')
  const toolNames = Array.isArray(bs.tool_names) ? bs.tool_names.map(String) : []
  const hasTools = Boolean(bs.has_tools)
  const hasContent = Boolean(bs.has_content)
  const contentPreview = bs.content_preview != null ? String(bs.content_preview) : ''
  return {
    kind: /** @type {ModelResponseSummary['kind']} */ (kind),
    kindLabelZh,
    kindLabelEn,
    toolNames,
    tools: toolNames.map((name) => ({ name, argsPreview: '', argsFull: null })),
    contentText: contentPreview,
    hasTools,
    hasContent,
  }
}

export async function renderModelsFromSqlite(page, { onPickThread } = {}) {
  installAgentTraceJsonModalDelegate()
  installAgentTraceSystemPromptDelegate()
  installModelDetailDelegate()
  const statsEl = page.querySelector('#at-models-stats')
  const tableBody = page.querySelector('#at-models-table-body')
  const filterWrap = page.querySelector('#at-models-filter-wrap')
  const paginationEl = page.querySelector('#at-models-pagination')

  if (filterWrap && !filterWrap.dataset.html) {
    filterWrap.dataset.html = '1'
    filterWrap.innerHTML = filterFormHtml(`
      ${renderObsFilterField('Thread ID', obsFilterInput('thread_id', 'style="min-width:220px"'))}
      ${renderObsFilterField('用途', obsFilterSelect('invocation_kind', `<option value="">全部</option>${invocationKindFilterOptions()
        .filter(Boolean)
        .map((k) => `<option value="${escHtml(k)}">${escHtml(formatInvocationKindLabel(k))}</option>`)
        .join('')}`))}`)
  }
  bindFilterForm(filterWrap, modelsState, () => void renderModelsFromSqlite(page, { onPickThread }))

  const parseJsonField = (raw) => {
    if (raw == null || raw === '') return null
    if (typeof raw === 'object') return raw
    try {
      return JSON.parse(String(raw))
    } catch {
      return String(raw)
    }
  }

  const q = _timeQ()
  const daysQ = obsDaysParam()
  const [ov, data, trends] = await Promise.all([
    api.observabilityOverview(q).catch(() => ({})),
    api.observabilityModels({ page: modelsState.page, page_size: 20, ...q, ...modelsState.filters }),
    api.observabilityTrends(daysQ).catch(() => null),
  ])
  const items = data.items || []
  const tok = ov.total_tokens || {}
  const totalTok = typeof tok === 'object' ? tok.total || 0 : tok
  statsEl.innerHTML = `
    ${renderObsKpiGrid([
      { label: '模型请求', value: fmtNum(data.total || ov.model_invocations || 0), footer: `本页 ${items.length} 条` },
      { label: 'P95 延迟', value: fmtMs(ov.model_latency_p95_ms), footer: `TTFT P95 ${fmtMs(ov.model_ttft_p95_ms)}` },
      { label: 'Token 总量', value: fmtNum(totalTok), footer: getObsTimeRangeLabel() },
    ])}
    ${renderObsTrendCharts(trends, getObsTimeRangeLabel())}
    <p class="obs-list-hint">模型请求明细 · ${getObsTimeRangeLabel()}</p>`

  if (!items.length) {
    tableBody.innerHTML = '<tr class="task-obs-table-row is-empty"><td colspan="14">暂无记录</td></tr>'
  } else {
    tableBody.innerHTML = items
      .map((row, i) => {
        const rowId = row.id
        const usageObj = parseJsonField(row.usage_json)
        const rowNum = (data.page - 1) * data.page_size + i + 1
        const tinRaw = formatObsUsageTok(row.usage_input_tokens)
        const tinFmt = formatModelInputTokensWithCompaction(usageObj, tinRaw)
        const tin = tinFmt.cellHtml
        const cacheFmt = formatCacheHitTokens(row.usage_cache_read_tokens, row.usage_cache_miss_tokens)
        const compressPass = formatCompressPassLabel(usageObj) || row.compaction_pass
        const kindLabelBase = formatInvocationKindLabel(row.invocation_kind)
        const kindLabel = compressPass ? `${kindLabelBase} (${compressPass})` : kindLabelBase

        const reqBtn = obsActionBtn('请求', 'ghost', `data-model-detail-id="${escHtml(rowId)}" data-model-detail-field="request_json" data-json-title="模型请求 #${rowNum}"`)
        const resBtn = obsActionBtn('响应', 'ghost', `data-model-detail-id="${escHtml(rowId)}" data-model-detail-field="response_json" data-json-title="模型响应 #${rowNum}"`)
        const usageBtn = obsActionBtn('usage', 'ghost', `data-model-detail-id="${escHtml(rowId)}" data-model-detail-field="usage_json" data-json-title="usage #${rowNum}"`)
        const sysBtn = obsActionBtn('系统提示词', 'secondary', `data-model-detail-id="${escHtml(rowId)}" data-model-detail-sys-prompt="1" data-json-title="系统提示词 #${rowNum}"`)

        const responseSummary = row.response_summary
          ? responseSummaryFromBackend(row.response_summary)
          : summarizeModelResponse(null)
        const responseTypeCell = renderModelResponseTypeCell(responseSummary, { escHtml })
        const responsePreviewCell = responseSummary?.contentText
          ? `<span class="obs-cell-muted">${escHtml(trunc(responseSummary.contentText, 96))}</span>`
          : `<span class="obs-cell-muted">点击响应查看</span>`
        return `<tr>
        <td class="task-obs-table-num">${rowNum}</td>
        <td>${escHtml(formatIso(row.requested_at))}</td>
        <td>${escHtml(kindLabel)}</td>
        <td class="task-obs-table-model">${escHtml(row.model || '—')}</td>
        <td class="task-obs-table-num">${formatDurationSec(row.latency_ms)}</td>
        <td class="task-obs-table-tokens"${tinFmt.title ? ` title="${escHtml(tinFmt.title)}"` : ''}>${tin}</td>
        <td class="task-obs-table-tokens"${cacheFmt.title ? ` title="${escHtml(cacheFmt.title)}"` : ''}>${cacheFmt.cellHtml}</td>
        <td class="task-obs-table-tokens">${escHtml(formatObsUsageTok(row.usage_output_tokens))}</td>
        <td>${obsCellLink(trunc(row.thread_id, 28), row.thread_id || '', row.thread_id || '')}</td>
        <td>${obsTableActions(sysBtn)}</td>
        <td>${obsTableActions(reqBtn)}</td>
        <td class="agent-trace-obs-model-response-type">${responseTypeCell}</td>
        <td class="agent-trace-obs-model-response-preview">${responsePreviewCell}</td>
        <td>${obsTableActions(`${resBtn}${usageBtn}`)}</td>
      </tr>`
      })
      .join('')
  }
  bindThreadLinks(page.querySelector('#at-models-table'), onPickThread)
  renderPaginationBar(paginationEl, data, (p) => {
    modelsState.page = p
    void renderModelsFromSqlite(page, { onPickThread })
  })
}

export async function renderThreadTimelineSqlite(page, threadId) {
  const el = page.querySelector('#at-sqlite-timeline')
  if (!el || !threadId) return
  el.innerHTML = '<p class="el-obs-hint">加载时光轴…</p>'
  const data = await api.observabilityThreadTimeline(threadId, 300)
  const items = data.items || []
  if (!items.length) {
    el.innerHTML = '<p class="el-obs-hint">该 Thread 在 SQLite 中暂无观测事件</p>'
    return
  }
  el.innerHTML = `<div class="agent-trace-tl">${items.map((it) => {
    const kind = it.kind || 'trace'
    const kindLab = formatInvocationKindLabel(it.invocation_kind)
    const title =
      kind === 'tool'
        ? `工具 ${it.tool_name}`
        : kind === 'model'
          ? `模型 [${kindLab}] ${it.model || ''}`.trim()
          : `${it.event || it.lane}`
    const sub = kind === 'tool'
      ? `${it.status} · ${formatDurationSec(it.duration_ms)}${it.error_message ? ' · ' + trunc(it.error_message, 60) : ''}`
      : kind === 'model'
        ? [
            it.stage || '',
            it.compaction_saved_gate_tokens
              ? `压缩 −${Math.round(Number(it.compaction_saved_gate_tokens))} gate tok`
              : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : trunc(it.payload_json, 100)
    return `<div class="el-obs-timeline-item">
        <div class="el-obs-timeline-item__time">${escHtml(formatIso(it.at))}</div>
        <div class="el-obs-timeline-item__title">${escHtml(title)}</div>
        <div class="el-obs-timeline-item__sub">${escHtml(sub)}</div>
      </div>`
  }).join('')}</div>`
}
