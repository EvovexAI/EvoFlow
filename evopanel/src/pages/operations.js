/**
 * 运维观测：左侧菜单 + 右侧独立数据看板（Element 风格）
 */
import { api } from '../lib/tauri-api.js'
import {
  fmtMs,
  fmtNum,
  fmtPct,
  getObsTimeRangeLabel,
  obsDaysParam,
  obsQueryParams,
  renderObsBarChart,
  renderObsElmCard,
  renderObsError,
  renderObsHBarList,
  renderObsKpiGrid,
  renderObsLoading,
  renderObsTable,
  renderObsTimeFilterBar,
  renderObsTopbar,
  renderObsTrendCharts,
  renderObsConsoleShell,
  bindObsSideNav,
  escHtml,
} from '../lib/obs-dashboard-ui.js'

const OPS_NAV = [
  { key: 'overview', label: '系统概览', hint: '工具/模型/Token' },
  { key: 'waterfall', label: '水位线', hint: '延迟阶段分解' },
  { key: 'report', label: '系统报告', hint: '健康评分与建议' },
]

function clearObsHostLayout() {
  document.getElementById('content')?.classList.remove('agent-trace-host')
  document.getElementById('agent-trace-root')?.classList.remove('agent-trace-host')
}

export function cleanup() {
  clearObsHostLayout()
}

export async function render() {
  clearObsHostLayout()

  const page = document.createElement('div')
  page.className = 'page page--ops obs-console-host'

  const state = { section: 'overview' }

  page.innerHTML = `
    <div class="page-header obs-console-page-header">
      <div>
        <h1 class="page-title">运维观测</h1>
        <p class="page-desc" id="ops-page-desc">系统运行指标与诊断分析</p>
      </div>
      <div class="page-actions">
        <a class="btn btn-ghost btn-sm" href="#/debug/agent-trace">Agent Trace</a>
        <button type="button" class="btn btn-secondary btn-sm" id="ops-refresh">刷新</button>
      </div>
    </div>
    <div class="tasks-time-filter-bar obs-console-time-bar" id="ops-time-filter-bar"></div>
    <div class="page-content ops-page-content obs-console-shell" id="ops-shell-mount"></div>
  `

  const mountShell = (section) => {
    const sec = OPS_NAV.find((n) => n.key === section) || OPS_NAV[0]
    const mount = page.querySelector('#ops-shell-mount')
    if (!mount) return
    mount.innerHTML = renderObsConsoleShell({
      brandTitle: '运维观测',
      brandCaption: getObsTimeRangeLabel(),
      navItems: OPS_NAV,
      activeKey: section,
      topbarHtml: renderObsTopbar({
        title: sec.label,
        subtitle: `${sec.hint || ''} · ${getObsTimeRangeLabel()}`,
      }),
      bodyHtml: renderObsLoading(),
    })
    bindObsSideNav(page.querySelector('#obs-side-nav'), (key) => {
      state.section = key
      mountShell(key)
      void loadSection(page, state)
    })
  }

  const refresh = () => {
    mountShell(state.section)
    void loadSection(page, state)
  }

  renderObsTimeFilterBar(page.querySelector('#ops-time-filter-bar'), refresh)
  page.querySelector('#ops-refresh')?.addEventListener('click', refresh)

  mountShell(state.section)
  void loadSection(page, state)
  return page
}

async function loadSection(page, state) {
  const panel = page.querySelector('#obs-main-panel')
  if (!panel) return
  const q = obsQueryParams()
  const daysQ = obsDaysParam()
  try {
    if (state.section === 'overview') await _renderOverview(panel, q, daysQ)
    else if (state.section === 'waterfall') await _renderWaterfall(panel, q)
    else if (state.section === 'report') await _renderReport(panel, q)
  } catch (err) {
    panel.innerHTML = renderObsError(`加载失败：${String(err?.message || err)}`)
  }
}

async function _renderOverview(panel, q, daysQ) {
  const [overview, insights, errors, trends] = await Promise.all([
    api.observabilityOverview(q).catch(() => null),
    api.observabilityInsights({ limit: '10', ...q }).catch(() => null),
    api.observabilityErrorsSummary(q).catch(() => null),
    api.observabilityTrends(daysQ).catch(() => null),
  ])
  if (!overview || Object.keys(overview).length === 0) {
    panel.innerHTML = renderObsError('观测数据不可用（SQLite 未启用或无数据）')
    return
  }

  const toolErrRate = overview.tool_error_rate ?? 0
  const kpis = renderObsKpiGrid([
    { label: '工具调用', value: fmtNum(overview.tool_invocations), footer: `错误率 ${fmtPct(toolErrRate)}` },
    { label: '模型调用', value: fmtNum(overview.model_invocations), footer: `P95 ${fmtMs(overview.model_latency_p95_ms)}` },
    { label: '首 Token P95', value: fmtMs(overview.model_ttft_p95_ms), footer: `P50 ${fmtMs(overview.model_ttft_p50_ms)}` },
    { label: 'Token 总量', value: fmtNum(overview.total_tokens), footer: `会话 ${fmtNum(overview.thread_count)}` },
    { label: '工具 P95', value: fmtMs(overview.tool_duration_p95_ms), footer: `均 ${fmtMs(overview.tool_avg_duration_ms)}` },
    { label: '模型均耗', value: fmtMs(overview.model_avg_latency_ms), footer: `${fmtNum(overview.model_invocations)} 次` },
  ])

  const trendCharts = renderObsTrendCharts(trends, getObsTimeRangeLabel())

  const errRows = (errors?.by_error_type || []).slice(0, 10)
  const errChart = errRows.length
    ? renderObsElmCard({
        title: '错误类型分布',
        bodyHtml: renderObsHBarList({ rows: errRows.map((r) => ({ label: r.error_type || '?', value: Number(r.count || 0) })) }),
      })
    : ''

  const recentErrs = insights?.recent_tool_errors || []
  const recentTable = recentErrs.length
    ? renderObsElmCard({
        title: '近期工具错误',
        bodyHtml: renderObsTable(
          ['工具', '错误', '时间'],
          recentErrs.slice(0, 12).map((r) => `<tr>
            <td class="task-obs-table-name">${escHtml(r.tool_name || '?')}</td>
            <td class="obs-error-cell__preview">${escHtml(String(r.error_message || '').slice(0, 120))}</td>
            <td class="task-obs-table-num">${escHtml(String(r.ended_at || '').slice(0, 19))}</td>
          </tr>`).join(''),
          { emptyColspan: 3, wrapPanel: false },
        ),
      })
    : ''

  panel.innerHTML = `<div class="obs-dashboard-stack">${kpis}${trendCharts}${errChart}${recentTable}</div>`
}

async function _renderWaterfall(panel, q) {
  const summary = await api.observabilityWaterfallSummary(q).catch(() => null)
  if (!summary?.aggregate || !Object.keys(summary.aggregate).length) {
    panel.innerHTML = renderObsError('水位线数据不可用')
    return
  }
  const agg = summary.aggregate
  const kpis = renderObsKpiGrid([
    { label: 'pre_model', value: fmtMs(agg.avg_pre_model_ms), footer: `P95 ${fmtMs(agg.p95_pre_model_ms)}` },
    { label: 'TTFT', value: fmtMs(agg.avg_ttft_ms), footer: `P95 ${fmtMs(agg.p95_ttft_ms)}` },
    { label: '推理', value: fmtMs(agg.avg_inference_ms), footer: `总 ${fmtMs(agg.avg_full_latency_ms)}` },
    { label: 'post_model', value: fmtMs(agg.avg_post_model_ms), footer: `工具 ${fmtMs(agg.avg_tool_ms)}` },
    { label: '周期总计', value: fmtMs(agg.avg_total_cycle_ms), footer: `P95 ${fmtMs(agg.p95_total_cycle_ms)}` },
    { label: '采样会话', value: fmtNum(summary.sampled_threads ?? 0), footer: getObsTimeRangeLabel() },
  ])

  const phaseChart = renderObsElmCard({
    title: '阶段耗时对比',
    subtitle: '平均值',
    bodyHtml: renderObsBarChart({
      items: [
        { label: 'pre', value: Number(agg.avg_pre_model_ms || 0) },
        { label: 'TTFT', value: Number(agg.avg_ttft_ms || 0) },
        { label: '推理', value: Number(agg.avg_inference_ms || 0) },
        { label: 'post', value: Number(agg.avg_post_model_ms || 0) },
        { label: '工具', value: Number(agg.avg_tool_ms || 0) },
        { label: '周期', value: Number(agg.avg_total_cycle_ms || 0) },
      ],
      color: '#409eff',
      valueFormatter: (n) => fmtMs(n),
    }),
  })

  const latencyTrend = renderObsElmCard({
    title: '阶段 P95 对比',
    bodyHtml: renderObsBarChart({
      items: [
        { label: 'pre', value: Number(agg.p95_pre_model_ms || 0) },
        { label: 'TTFT', value: Number(agg.p95_ttft_ms || 0) },
        { label: '推理', value: Number(agg.p95_inference_ms || 0) },
        { label: 'post', value: Number(agg.p95_post_model_ms || 0) },
        { label: '周期', value: Number(agg.p95_total_cycle_ms || 0) },
      ],
      color: '#e6a23c',
      valueFormatter: (n) => fmtMs(n),
    }),
  })

  const bottlenecks = summary.bottlenecks || []
  const bn = bottlenecks.length
    ? renderObsElmCard({
        title: '瓶颈检测',
        bodyHtml: renderObsTable(
          ['类型', '阶段', '现象', '提示'],
          bottlenecks.slice(0, 15).map((b) => `<tr class="${b.type === 'aggregate' ? 'ops-row-warn' : ''}">
            <td>${b.type === 'aggregate' ? '聚合' : '周期'}</td>
            <td>${escHtml(b.phase || '?')}</td>
            <td>${escHtml(b.phenomenon || '')}</td>
            <td>${escHtml(b.hint || '')}</td>
          </tr>`).join(''),
          { emptyColspan: 4, wrapPanel: false },
        ),
      })
    : ''

  panel.innerHTML = `<div class="obs-dashboard-stack">${kpis}<div class="obs-charts-row">${phaseChart}${latencyTrend}</div>${bn}</div>`
}

async function _renderReport(panel, q) {
  const report = await api.observabilityReport(q).catch(() => null)
  if (!report || report.enabled === false) {
    panel.innerHTML = renderObsError('系统报告不可用')
    return
  }
  const recs = report.recommendations || []
  const evalF = report.eval_findings || {}
  const evalKpis = []
  if (evalF.health_score != null) {
    evalKpis.push({ label: '健康评分', value: `${(evalF.health_score * 100).toFixed(1)}%`, footer: '综合评估' })
  }
  if (evalF.global_p95_ttft != null) {
    evalKpis.push({ label: '全局 P95 TTFT', value: fmtMs(evalF.global_p95_ttft), footer: '首 Token' })
  }
  if (evalF.invalid_tool_call_rate != null) {
    evalKpis.push({ label: '无效工具调用率', value: fmtPct(evalF.invalid_tool_call_rate), footer: '需关注' })
  }

  const evalCards = evalKpis.length ? renderObsKpiGrid(evalKpis) : ''
  const recHtml = recs.length
    ? renderObsElmCard({
        title: '优化建议',
        subtitle: `${recs.length} 条 · 生成 ${String(report.generated_at || '').slice(0, 19)}`,
        bodyHtml: `<div class="ops-recommendations">${recs.map((r) => `
          <div class="stat-card ops-rec ops-rec--${escHtml(r.priority || 'P2')}">
            <div class="ops-rec-header">
              <span class="ops-rec-priority">${escHtml(r.priority || 'P2')}</span>
              <span class="ops-rec-dim">${escHtml(r.dimension || '')}</span>
              <span class="ops-rec-phenomenon">${escHtml(r.phenomenon || '')}</span>
            </div>
            <div class="ops-rec-action">操作：${escHtml(r.suggested_action || '')}</div>
            <div class="ops-rec-verify">验证：${escHtml(r.verification || '')}</div>
          </div>`).join('')}</div>`,
      })
    : ''

  const dims = report.dimensions || {}
  const slowTools = dims.tool_latency?.top_slow_tools || []
  const slowToolsHtml = slowTools.length
    ? renderObsElmCard({
        title: '最慢工具 Top 10',
        bodyHtml: renderObsTable(
          ['工具', '次数', '平均', '最大'],
          slowTools.slice(0, 10).map((r) => `<tr>
            <td>${escHtml(r.tool_name || '?')}</td>
            <td>${fmtNum(r.invocation_count)}</td>
            <td>${fmtMs(r.avg_duration_ms)}</td>
            <td>${fmtMs(r.max_duration_ms)}</td>
          </tr>`).join(''),
          { emptyColspan: 4, wrapPanel: false },
        ),
      })
    : ''

  panel.innerHTML = `<div class="obs-dashboard-stack">${evalCards}${recHtml}${slowToolsHtml}</div>`
}
