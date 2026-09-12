/**
 * Agent trace debug: Gateway /api/debug/agent-trace/* plus optional SQLite observability.
 * Log trace: enabled by default (EVOFLOW_DEBUG_TRACE_UI=0 to disable). SQLite panels: Gateway /api/observability.
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { navigate } from '../router.js'
import { AT, biHtml, biText } from './agent-trace-i18n.js'
import { installAgentTraceJsonModalDelegate, stashJsonForModal } from './agent-trace-json-modal.js'
import {
  installAgentTraceSystemPromptDelegate,
  stashSystemPromptForModal,
} from './agent-trace-system-prompt.js'
import { formatDurationSec } from './agent-trace-format.js'
import {
  collabGraphStageLabelZh,
  collabPhaseLabelZh,
  lifecycleEventLabelZh,
  lifecycleStatusLabelZh,
  roundEventLabelZh,
} from './agent-trace-field-glossary.js'
import {
  isObservabilityEnabled,
  renderGatewayRequestsFromSqlite,
  renderModelsFromSqlite,
  renderOverviewFromSqlite,
  renderToolsFromSqlite,
} from './agent-trace-obs-sqlite.js'
import {
  renderObsTimeFilterBar,
  getObsTimeRangeLabel,
  fmtNum,
  fmtPct,
  fmtMs,
  obsQueryParams,
  renderObsSideNav,
  bindObsSideNav,
  renderObsTopbar,
  loadSessionTitleMap,
  sessionDisplayTitle,
} from '../lib/obs-dashboard-ui.js'
import {
  formatInvocationKindLabel,
  resolveInvocationKindFromRecord,
} from './agent-trace-invocation-kinds.js'

const AT_MENU_GROUPS = [
  { key: 'overview', label: '总览', hint: '工具/模型/Token 统计排行', tone: 'primary' },
  { key: 'tools', label: '工具调用', hint: '工具执行明细与报错', tone: 'info' },
  { key: 'models', label: '模型请求', hint: '模型调用与 Token 明细', tone: 'warning' },
  { key: 'gateway', label: 'Gateway', hint: 'HTTP 请求追踪', tone: 'muted' },
  { key: 'sessions', label: '会话调试', hint: 'Trace 时间线与原始数据', tone: 'success' },
]

const LIST_SEP = '\u3001'

const MID_DOT = '\u00b7'
const EM_DASH = '\u2014'

let _pollTimer = null
/** @type {null | (() => void)} */
let _detachAgentTraceHashSync = null

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function getHashQuery() {
  const h = window.location.hash.slice(1) || ''
  const qi = h.indexOf('?')
  if (qi < 0) return new URLSearchParams()
  return new URLSearchParams(h.slice(qi + 1))
}

function getRouteThreadId() {
  const q = getHashQuery()
  return (q.get('thread_id') || '').trim()
}

/** ? turn / ??? ? ????????????? [0, turns.length-1] */
function resolveTurnIndexFromRoute(turns) {
  const list = Array.isArray(turns) ? turns : []
  const n = list.length
  if (!n) return 0
  const raw = (getHashQuery().get('turn') || '').trim().toLowerCase()
  if (!raw || raw === 'all') return n - 1
  const t = parseInt(raw, 10)
  if (!Number.isFinite(t) || t < 0) return n - 1
  return Math.min(t, n - 1)
}

function normalizeAgentTraceHash(threadId, turnIdx) {
  const tid = String(threadId || '').trim()
  if (!tid) return
  const want = `#/debug/agent-trace?thread_id=${encodeURIComponent(tid)}&turn=${turnIdx}`
  if (window.location.hash !== want) {
    const u = new URL(window.location.href)
    u.hash = want
    history.replaceState(null, '', u.toString())
  }
}

function navigateAgentTrace(threadId) {
  const tid = String(threadId || '').trim()
  if (!tid) {
    navigate('/debug/agent-trace')
    return
  }
  navigate(`/debug/agent-trace?thread_id=${encodeURIComponent(tid)}`)
}

function formatMs(ms) {
  if (ms == null || ms === '') return EM_DASH
  const n = Number(ms)
  if (Number.isNaN(n)) return String(ms)
  try {
    return new Date(n).toLocaleString()
  } catch {
    return String(ms)
  }
}

function formatIso(v) {
  if (v == null || v === '') return EM_DASH
  if (typeof v === 'number') return formatMs(v)
  const d = new Date(String(v))
  if (!Number.isNaN(d.getTime())) return d.toLocaleString()
  return String(v).length > 28 ? String(v).slice(0, 25) + '\u2026' : String(v)
}

function trunc(s, n) {
  const t = String(s ?? '')
  if (t.length <= n) return t
  return t.slice(0, n - 1) + '\u2026'
}

/** API ???? {} ??????? forEach ?? */
function asArray(v) {
  return Array.isArray(v) ? v : []
}

/** ??? ``_epoch_ms_from_any`` ?????????? */
function epochMsFromAny(value) {
  if (value == null || typeof value === 'boolean') return null
  if (typeof value === 'number') {
    const n = value
    if (!Number.isFinite(n)) return null
    if (n > 1e12) return n
    if (n > 1e9) return n * 1000
    return n * 1000
  }
  if (typeof value === 'string') {
    const s = value.trim()
    if (!s) return null
    const iso = s.endsWith('Z') ? s : s
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T'))
    if (!Number.isNaN(d.getTime())) return d.getTime()
    const f = parseFloat(s)
    if (!Number.isFinite(f)) return null
    return f * 1000
  }
  return null
}

function inTurnWindow(t, startMs, endMs) {
  if (t == null || Number.isNaN(t)) return false
  if (t + 1e-6 < startMs) return false
  if (endMs != null && Number.isFinite(endMs) && t >= endMs - 1e-6) return false
  return true
}

/** @param {HTMLElement} parent @param {unknown} maxChars 兼容旧调用；完整 JSON 统一用弹窗 */
function appendDetailJson(parent, titleZh, titleEn, data, maxChars = 16000) {
  void maxChars
  const wrap = document.createElement('div')
  wrap.className = 'agent-trace-json-trigger-row'
  const lab = document.createElement('span')
  lab.className = 'agent-trace-json-trigger-label'
  lab.innerHTML = biHtml(titleZh, titleEn)
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'agent-trace-json-modal-open'
  btn.setAttribute('data-json-ref', stashJsonForModal(data))
  btn.setAttribute('data-json-title', biText(titleZh, titleEn))
  btn.textContent = biText(AT.jsonModalOpenZh, AT.jsonModalOpenEn)
  wrap.appendChild(lab)
  wrap.appendChild(btn)
  parent.appendChild(wrap)
}

/** 系统提示全文：专用弹窗（支持多段、字符数、复制） */
function appendFullSystemPrompt(parent, textOrSegments) {
  const segments = Array.isArray(textOrSegments)
    ? textOrSegments.filter((s) => String(s || '').trim())
    : String(textOrSegments || '').trim()
      ? [String(textOrSegments)]
      : []
  if (!segments.length) return
  const fullText = segments.length === 1 ? segments[0] : segments.join('\n\n')
  const wrap = document.createElement('div')
  wrap.className = 'agent-trace-json-trigger-row agent-trace-json-trigger-row--block'
  const lab = document.createElement('span')
  lab.className = 'agent-trace-json-trigger-label'
  lab.innerHTML = biHtml(AT.detailKeys.systemPromptFullZh, AT.detailKeys.systemPromptFullEn)
  const meta = document.createElement('span')
  meta.className = 'agent-trace-json-trigger-meta'
  meta.lang = 'zh-CN'
  meta.textContent = biText(AT.systemPromptCharCountZh(fullText.length), AT.systemPromptCharCountEn(fullText.length))
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'agent-trace-sys-prompt-open'
  const ref = stashSystemPromptForModal({ segments, fullText })
  btn.setAttribute('data-sys-prompt-ref', ref)
  btn.setAttribute('data-sys-prompt-title', biText(AT.detailKeys.systemPromptFullZh, AT.detailKeys.systemPromptFullEn))
  btn.textContent = biText(AT.jsonModalOpenZh, AT.jsonModalOpenEn)
  wrap.appendChild(lab)
  wrap.appendChild(meta)
  wrap.appendChild(btn)
  parent.appendChild(wrap)
}

/** @param {unknown} v */
function asStringList(v) {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x)).filter((s) => s.length > 0)
}

/** ? ``messages`` ? ``role=user`` ?????????????? API messages ?????? */
function payloadContextUserTurnCount(rec) {
  if (!rec || typeof rec !== 'object') return null
  const pl = rec.payload
  if (!pl || typeof pl !== 'object' || !Array.isArray(pl.messages)) return null
  let n = 0
  for (const m of pl.messages) {
    if (m && typeof m === 'object' && String(m.role || '').trim().toLowerCase() === 'user') n += 1
  }
  return n
}

/** @param {unknown} payload ????? */
function inferThinkingEnabledFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null
  const p = /** @type {Record<string, unknown>} */ (payload)
  const eb = p.extra_body
  if (eb && typeof eb === 'object') {
    const e = /** @type {Record<string, unknown>} */ (eb)
    const et = e.enable_thinking
    if (et === true || String(et).toLowerCase() === 'true' || String(et) === '1') return true
    if (et === false || String(et).toLowerCase() === 'false') return false
    const th = e.thinking
    if (th === true) return true
    if (th === false) return false
    if (th && typeof th === 'object') {
      const t = /** @type {Record<string, unknown>} */ (th)
      const typ = String(t.type || '').toLowerCase()
      if (typ === 'enabled' || t.enabled === true) return true
      if (typ === 'disabled' || t.enabled === false) return false
    }
    if (e.reasoning_split === true) return true
  }
  const re = p.reasoning_effort
  if (typeof re === 'string' && re.trim()) {
    const rl = re.trim().toLowerCase()
    if (rl === 'off' || rl === 'none' || rl === 'disable' || rl === 'disabled') return false
    return true
  }
  if (p.thinking === true) return true
  if (p.thinking === false) return false
  return null
}

function formatThinkingLabel(tri) {
  if (tri === true) return biText(AT.meta.thinkingYesZh, AT.meta.thinkingYesEn)
  if (tri === false) return biText(AT.meta.thinkingNoZh, AT.meta.thinkingNoEn)
  return biText(AT.meta.thinkingUnknownZh, AT.meta.thinkingUnknownEn)
}

/** ???????????????????``tools`` ??? messages ? ``tool_calls``? */
function toolNamesFromVendorPayload(payload) {
  if (!payload || typeof payload !== 'object') return []
  const out = []
  const tools = /** @type {Record<string, unknown>} */ (payload).tools
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (!t || typeof t !== 'object') continue
      const tr = /** @type {Record<string, unknown>} */ (t)
      const fn = tr.function
      if (fn && typeof fn === 'object' && fn.name) out.push(String(fn.name))
      else if (tr.name != null && String(tr.name)) out.push(String(tr.name))
    }
  }
  if (out.length) return [...new Set(out)]
  const messages = /** @type {Record<string, unknown>} */ (payload).messages
  if (!Array.isArray(messages)) return []
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const tcs = /** @type {Record<string, unknown>} */ (m).tool_calls
    if (!Array.isArray(tcs)) continue
    for (const tc of tcs) {
      if (!tc || typeof tc !== 'object') continue
      const fn = /** @type {Record<string, unknown>} */ (tc).function
      const n = (fn && typeof fn === 'object' && fn.name) || /** @type {Record<string, unknown>} */ (tc).name
      if (n) out.push(String(n))
    }
  }
  return [...new Set(out)]
}

function safeJsonPreview(obj, maxLen) {
  try {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
    return trunc(s, maxLen)
  } catch {
    return trunc(String(obj), maxLen)
  }
}

/**
 * ??? collab_cycle ?????????????? collab_phase??? set_collab_phase / to_phase?Plan ???????????
 * @param {Record<string, unknown> | null | undefined} d
 */
function effectiveCollabPhaseFromRow(d) {
  if (!d || typeof d !== 'object') return undefined
  const cp = d.collab_phase != null && String(d.collab_phase).trim() ? String(d.collab_phase).trim() : ''
  if (cp && cp.toLowerCase() !== 'idle') return cp
  const st = d.set_collab_phase != null && String(d.set_collab_phase).trim() ? String(d.set_collab_phase).trim() : ''
  if (st && st.toLowerCase() !== 'idle') return st
  const tp = d.to_phase != null && String(d.to_phase).trim() ? String(d.to_phase).trim() : ''
  if (tp && tp.toLowerCase() !== 'idle') return tp
  return undefined
}

/** @typedef {{ startMs: number; endMs: number | null; index1: number; modelCallSeq: unknown }} ModelCycleWindow */

/** ? turn.model_cycles ???????????????? Gateway conversation_turns ??? */
function buildModelCycleWindows(turn) {
  const cycles = asArray(turn.model_cycles)
  const endTurn =
    turn.end_ms != null && Number.isFinite(Number(turn.end_ms)) ? Number(turn.end_ms) : null
  return cycles.map((cy, j) => {
    const t0 = epochMsFromAny(cy.timestamp_ms ?? cy.timestamp)
    const t0n = t0 != null && !Number.isNaN(t0) ? t0 : 0
    let t1
    if (j + 1 < cycles.length) {
      t1 = epochMsFromAny(cycles[j + 1].timestamp_ms ?? cycles[j + 1].timestamp)
    } else {
      t1 = endTurn
    }
    return { startMs: t0n, endMs: t1, index1: j + 1, modelCallSeq: cy.model_call_seq }
  })
}

/** @param {ModelCycleWindow[]} windows */
function cycleIndexFromTs(windows, t) {
  if (t == null || Number.isNaN(Number(t))) return null
  const tt = Number(t)
  for (const w of windows) {
    if (tt + 1e-6 < w.startMs) continue
    if (w.endMs != null && Number.isFinite(Number(w.endMs)) && tt >= Number(w.endMs) - 1e-6) continue
    return w.index1
  }
  return null
}

/** @param {Record<string, unknown>} turn */
function cycleIndexFromModelCallSeq(turn, seq) {
  if (seq == null || seq === '') return null
  const n = Number(seq)
  if (!Number.isFinite(n)) return null
  const cycles = asArray(turn.model_cycles)
  for (let j = 0; j < cycles.length; j++) {
    if (Number(cycles[j].model_call_seq) === n) return j + 1
  }
  return null
}

/** @param {{ kind: string; data?: unknown }} ev */
function eventPhaseKey(ev) {
  const k = ev.kind
  if (k === 'user') return 'phase_user'
  if (k === 'lifecycle') return 'phase_lifecycle'
  if (k === 'model_call') return 'phase_model_schedule'
  if (k === 'model_http') return 'phase_vendor_http'
  if (k === 'tool') return 'phase_tool_record'
  if (k === 'round') return 'phase_round_trace'
  if (k === 'collab' && ev.data && typeof ev.data === 'object') {
    const e = String(/** @type {Record<string, unknown>} */ (ev.data).event || '').trim().toLowerCase()
    const core = {
      before_model: 'phase_collab_before_model',
      model_request: 'phase_collab_model_request',
      model_response: 'phase_collab_model_response',
      after_model: 'phase_collab_after_model',
      tool_start: 'phase_collab_tool_start',
      tool_end: 'phase_collab_tool_end',
    }
    if (core[e]) return core[e]
    if (e.startsWith('plan_guard') || e === 'supervisor_gated_until_plan') return 'phase_collab_plan_guard'
    if (e.startsWith('auto_enter') || e.startsWith('supervisor_root_task_bound')) return 'phase_collab_scenario'
    return 'phase_collab_other'
  }
  return 'phase_other'
}

function phaseKeyToDotClass(pk) {
  const s = String(pk || 'phase_other').replace(/^phase_/, '').replace(/_/g, '-')
  return `agent-trace-tl-dot--phase-${s}`
}

/** ??????????????idle ???????? */
function collabPhaseForRailLine(own, carried) {
  const norm = (v) => (v != null && String(v).trim() ? String(v).trim() : '')
  const o = norm(own)
  if (o.toLowerCase() === 'idle') return ''
  if (o) return o
  const c = norm(carried)
  if (c.toLowerCase() === 'idle') return ''
  return c
}

function normPhaseKey(s) {
  if (s == null || !String(s).trim()) return ''
  return String(s).trim().toLowerCase()
}

/**
 * ?????????????????????????????
 * @param {string} actionLine ??????????
 * @param {{ lastRailPhaseKey: string | null }} phaseCarry
 * @param {string} phaseStr ???????????????
 */
function railWithDedupedPhase(actionLine, phaseCarry, phaseStr) {
  const pk = normPhaseKey(phaseStr)
  const showPhase = pk && pk !== normPhaseKey(phaseCarry.lastRailPhaseKey)
  const phaseLabel = phaseStr ? collabPhaseLabelZh(phaseStr) : ''
  if (showPhase && pk) phaseCarry.lastRailPhaseKey = phaseStr
  if (!actionLine) return showPhase && phaseLabel ? `\u9636\u6bb5${MID_DOT}${phaseLabel}` : ''
  if (!showPhase || !phaseLabel) return actionLine
  return `${actionLine}${MID_DOT}${phaseLabel}`
}

/**
 * @param {{ kind: string; data?: unknown; cycleIndex?: number | null }} ev
 * @param {{ current: string | null; lastRailPhaseKey: string | null }} phaseCarry
 */
function timelineRailPhaseTextInner(ev, phaseCarry) {
  const carriedCollabPhase = phaseCarry.current
  const d = ev.data
  const rowPhase =
    d && typeof d === 'object'
      ? effectiveCollabPhaseFromRow(/** @type {Record<string, unknown>} */ (d))
      : undefined
  const phaseStr = collabPhaseForRailLine(rowPhase, carriedCollabPhase)

  if (ev.kind === 'user') {
    return railWithDedupedPhase(biText(AT.kf.userInputZh, 'User input'), phaseCarry, phaseStr)
  }
  if (ev.kind === 'collab' && d && typeof d === 'object') {
    const evn = String(/** @type {Record<string, unknown>} */ (d).event || '')
    return railWithDedupedPhase(collabGraphStageLabelZh(evn), phaseCarry, phaseStr)
  }
  if (ev.kind === 'model_call') {
    return railWithDedupedPhase(biText(AT.prefixes.modelCallZh, AT.prefixes.modelCallEn), phaseCarry, phaseStr)
  }
  if (ev.kind === 'round' && d && typeof d === 'object') {
    const re = String(/** @type {Record<string, unknown>} */ (d).event || '')
    return railWithDedupedPhase(roundEventLabelZh(re), phaseCarry, phaseStr)
  }
  if (ev.kind === 'model_http' && d && typeof d === 'object') {
    return railWithDedupedPhase(biText(AT.modelHttpDebugTitleZh, AT.modelHttpDebugTitleEn), phaseCarry, phaseStr)
  }
  if (ev.kind === 'tool') {
    return railWithDedupedPhase(biText(AT.prefixes.toolZh, AT.prefixes.toolEn), phaseCarry, phaseStr)
  }
  if (ev.kind === 'lifecycle' && d && typeof d === 'object') {
    const row = /** @type {Record<string, unknown>} */ (d)
    const evn = lifecycleEventLabelZh(row.event)
    const stRaw = row.status
    const st = stRaw != null && String(stRaw).trim() ? lifecycleStatusLabelZh(stRaw) : ''
    const detail = evn && st ? `${evn} ${MID_DOT} ${st}` : evn || st || ''
    const life = biText(AT.prefixes.lifecycleZh, AT.prefixes.lifecycleEn)
    const actionLine = detail ? `${life} ${MID_DOT} ${detail}` : life
    return railWithDedupedPhase(actionLine, phaseCarry, phaseStr)
  }
  return railWithDedupedPhase('', phaseCarry, phaseStr)
}


/**
 * @param {{ hideCycleBanner?: boolean }} [opts] ???? N ??????????????????????N???
 */
function finalizeRailText(ev, phaseCarry, opts) {
  opts = opts || {}
  const raw = timelineRailPhaseTextInner(ev, phaseCarry)
  const ci = /** @type {{ cycleIndex?: number | null }} */ (ev).cycleIndex
  if (opts.hideCycleBanner) return raw
  if (ci != null && ci >= 1 && ev.kind !== 'user') {
    const body = (raw || '').trim()
    return body ? `\u7b2c ${ci} \u6b21\n${body}` : `\u7b2c ${ci} \u6b21`
  }
  return raw
}

/** ???????????N????????? opts.hideCycleBanner ??? */
function timelineRailPhaseText(ev, phaseCarry, opts) {
  return finalizeRailText(ev, phaseCarry, opts)
}

/**
 * ???????????????????? cycleIndex ????????null/&lt;1 ????????
 */
function splitEventsByModelCycleSegments(events) {
  /** @type {Array<{ cycleNum: number | null; items: typeof events }>} */
  const out = []
  /** @type {string | null} */
  let curKey = null
  /** @type {typeof events} */
  let cur = []
  for (const ev of events) {
    const ciRaw = /** @type {{ cycleIndex?: number | null }} */ (ev).cycleIndex
    const ci = ciRaw != null && ciRaw >= 1 ? Number(ciRaw) : null
    const key = ci === null ? 'pre' : `n${ci}`
    if (curKey === null) curKey = key
    else if (key !== curKey) {
      const cycleNum = curKey === 'pre' ? null : parseInt(curKey.slice(1), 10)
      out.push({ cycleNum: Number.isFinite(cycleNum) ? cycleNum : null, items: cur })
      cur = []
      curKey = key
    }
    cur.push(ev)
  }
  if (cur.length && curKey !== null) {
    const cycleNum = curKey === 'pre' ? null : parseInt(curKey.slice(1), 10)
    out.push({ cycleNum: Number.isFinite(cycleNum) ? cycleNum : null, items: cur })
  }
  return out
}

/**
 * ?????????????????????????????????????????
 * @param {Array<{ cycleNum: number | null; items: unknown[]; timelineOnly?: boolean }>} segments
 */
function mergeLeadingPreModelCycleSegments(segments) {
  if (!segments.length) return segments
  /** @type {unknown[]} */
  let preItems = []
  let i = 0
  for (; i < segments.length; i++) {
    const s = segments[i]
    if (s.cycleNum != null && s.cycleNum >= 1) break
    preItems = preItems.concat(s.items)
  }
  if (i === 0) return segments
  if (i >= segments.length) {
    return [{ cycleNum: null, items: preItems, timelineOnly: true }]
  }
  const firstReal = segments[i]
  return [{ cycleNum: firstReal.cycleNum, items: preItems.concat(firstReal.items) }, ...segments.slice(i + 1)]
}

const _FOLD_MODEL_KINDS = new Set(['model_call', 'model_http'])

/** @param {{ items?: unknown[] }} seg */
function foldLastToolEvent(seg) {
  if (!seg || !Array.isArray(seg.items)) return null
  const tools = seg.items.filter((e) => /** @type {{ kind?: string }} */ (e).kind === 'tool')
  return tools.length ? tools[tools.length - 1] : null
}

/** ????????????? JSON???????????? */
function foldToolReturnHint(rec) {
  if (!rec || typeof rec !== 'object') return ''
  const out = /** @type {Record<string, unknown>} */ (rec).output
  if (typeof out === 'string') {
    const s = out.trim().replace(/\s+/g, ' ')
    return s ? trunc(s, 88) : ''
  }
  if (out && typeof out === 'object') {
    const o = /** @type {Record<string, unknown>} */ (out)
    for (const k of ['message', 'statusZh', 'status', 'summary', 'content', 'text']) {
      const v = o[k]
      if (typeof v === 'string' && v.trim()) return trunc(v.trim().replace(/\s+/g, ' '), 88)
    }
  }
  const st = /** @type {Record<string, unknown>} */ (rec).status
  if (typeof st === 'string' && st.trim()) return trunc(st.trim(), 40)
  return ''
}

/** ????????????????????? model ????????????? */
function foldPhaseBeforeFirstModel(seg) {
  if (!seg || !Array.isArray(seg.items)) return ''
  let lastPh = ''
  for (const ev of seg.items) {
    if (_FOLD_MODEL_KINDS.has(/** @type {{ kind?: string }} */ (ev).kind || '')) break
    if (/** @type {{ kind?: string }} */ (ev).kind === 'collab' && ev.data && typeof ev.data === 'object') {
      const eff = effectiveCollabPhaseFromRow(/** @type {Record<string, unknown>} */ (ev.data))
      if (eff) lastPh = collabPhaseLabelZh(eff)
    }
  }
  return lastPh
}

function foldUserQuestionSnippet(turn, seg) {
  let text = ''
  if (turn.user_input != null && String(turn.user_input).trim()) text = String(turn.user_input).trim()
  else {
    const u = seg.items.find((e) => /** @type {{ kind?: string }} */ (e).kind === 'user')
    if (u && u.data && typeof u.data === 'object') {
      const ui = /** @type {Record<string, unknown>} */ (u.data).user_input
      if (ui != null && String(ui).trim()) text = String(ui).trim()
    }
  }
  if (!text) return ''
  return biText(
    AT.modelCycleFoldCauseUserZh(trunc(text.replace(/\s+/g, ' '), 120)),
    AT.modelCycleFoldCauseUserEn(trunc(text.replace(/\s+/g, ' '), 120)),
  )
}

/**
 * ?? summary ?????????????????????????+??????????????????
 * @param {Record<string, unknown>} turn
 * @param {{ cycleNum: number | null; items: unknown[]; timelineOnly?: boolean }} seg
 * @param {typeof seg | null} prevSeg
 */
function buildModelCycleFoldCauseLine(turn, seg, prevSeg) {
  const cy = seg.cycleNum
  if (cy != null && cy >= 2 && prevSeg) {
    const lt = foldLastToolEvent(prevSeg)
    if (lt && lt.data && typeof lt.data === 'object') {
      const rec = /** @type {Record<string, unknown>} */ (lt.data)
      const name = String(rec.tool_name || '').trim() || 'tool'
      const hint = foldToolReturnHint(rec)
      return biText(AT.modelCycleFoldCauseToolZh(name, hint), AT.modelCycleFoldCauseToolEn(name, hint))
    }
  }
  if (cy === 1 || seg.timelineOnly) {
    const phase = foldPhaseBeforeFirstModel(seg)
    const userLine = foldUserQuestionSnippet(turn, seg)
    if (phase && userLine) return `${phase} ${MID_DOT} ${userLine}`
    if (userLine) return userLine
    if (phase) return phase
    return ''
  }
  return ''
}

function formatActivatedScenariosForBanner(v) {
  if (v == null) return EM_DASH
  if (Array.isArray(v)) {
    const parts = v.map((x) => String(x).trim()).filter(Boolean)
    return parts.length ? parts.join(LIST_SEP) : EM_DASH
  }
  const s = String(v).trim()
  return s || EM_DASH
}

/** ????? model_call_tools ?????????????? chat ?? plan????? turn_snapshot */
function scenariosLabelForCycle(turn, seg) {
  const cyNum = seg.cycleNum
  const cycles = asArray(turn.model_cycles)
  if (cyNum != null && cyNum >= 1) {
    const cy = cycles[cyNum - 1]
    if (cy && typeof cy === 'object') {
      const ac = /** @type {Record<string, unknown>} */ (cy).activated_scenarios
      if (ac != null) {
        const line = formatActivatedScenariosForBanner(ac)
        if (line !== EM_DASH) return line
      }
    }
  }
  return formatActivatedScenariosForBanner(turn.activated_scenarios)
}

/** @param {Record<string, unknown> | null | undefined} row */
function tokenCountsFromUsageDebugRow(row) {
  if (!row || typeof row !== 'object') return null
  const inf = row.inferred_normalized
  if (inf && typeof inf === 'object') {
    const inp = inf.input_tokens ?? inf.prompt_tokens
    const out = inf.output_tokens ?? inf.completion_tokens
    if (inp != null || out != null) {
      return { in: inp != null ? String(inp) : null, out: out != null ? String(out) : null }
    }
  }
  const prev = row.response_token_usage_preview
  if (prev && typeof prev === 'object') {
    const inp = prev.input_tokens ?? prev.prompt_tokens
    const out = prev.output_tokens ?? prev.completion_tokens
    if (inp != null || out != null) {
      return { in: inp != null ? String(inp) : null, out: out != null ? String(out) : null }
    }
  }
  return null
}

/** 本轮 wall 时间（turn_snapshot 起止） */
function turnWallDurationMs(turn) {
  if (!turn || typeof turn !== 'object') return null
  const s = /** @type {Record<string, unknown>} */ (turn).start_ms
  const e = /** @type {Record<string, unknown>} */ (turn).end_ms
  if (s == null || e == null) return null
  const ds = Number(s)
  const de = Number(e)
  if (!Number.isFinite(ds) || !Number.isFinite(de) || de < ds) return null
  return de - ds
}

/** 本轮内各 model_cycle 关联的厂商请求 vendor_latency_ms 之和 */
function turnVendorLatencySumMs(payload, turn) {
  const models = asArray(payload.model_request_payloads)
  if (!models.length) return null
  const cycles = asArray(turn.model_cycles)
  if (!cycles.length) return null
  const seen = new Set()
  let sum = 0
  let any = false
  for (const cy of cycles) {
    if (!cy || typeof cy !== 'object') continue
    const indices = asArray(/** @type {Record<string, unknown>} */ (cy).model_request_payload_indices)
    for (const ii of indices) {
      const i = typeof ii === 'number' ? ii : Number.parseInt(String(ii), 10)
      if (!Number.isFinite(i) || i < 0 || i >= models.length || seen.has(i)) continue
      seen.add(i)
      const rec = /** @type {Record<string, unknown>} */ (models[i])
      const lat = rec.vendor_latency_ms
      if (lat != null && Number.isFinite(Number(lat))) {
        sum += Number(lat)
        any = true
      }
    }
  }
  return any ? sum : null
}

/** Per-turn timing from ``conversation_turns.turns[].timing`` or payload fallbacks. */
function getTurnTiming(turn, payload, turnIndex) {
  if (turn && typeof turn.timing === 'object' && turn.timing) {
    return /** @type {Record<string, unknown>} */ (turn.timing)
  }
  const turns = asArray(payload?.conversation_turns?.turns)
  const isLast = turnIndex >= turns.length - 1
  const e2e =
    isLast && payload?.end_to_end_timing && typeof payload.end_to_end_timing === 'object'
      ? payload.end_to_end_timing.segments_ms || {}
      : {}
  return {
    turn_index: turnIndex,
    turn_label: turn?.label || `用户第 ${turnIndex + 1} 轮`,
    turn_wall_ms: turnWallDurationMs(turn),
    main_model_vendor_ms: turnVendorLatencySumMs(payload, turn),
    vendor_sum_ms: turnVendorLatencySumMs(payload, turn),
    vendor_by_kind_ms: {},
    page_round_trip_ms: isLast ? e2e.page_round_trip_ms : undefined,
    page_time_to_first_token_ms: isLast ? e2e.page_time_to_first_token_ms : undefined,
    gateway_stream_wall_ms: isLast ? e2e.gateway_stream_wall_ms : undefined,
    note_zh: '缺少服务端 timing 字段；请重启 Gateway 后发新消息。',
  }
}

/**
 * @param {Record<string, unknown>} timing
 * @returns {string}
 */
function renderTurnTimingPanelHtml(timing) {
  if (!timing || typeof timing !== 'object') return ''
  const turnLabel =
    timing.turn_label != null && String(timing.turn_label).trim()
      ? String(timing.turn_label).trim()
      : timing.turn_index != null
        ? biText(AT.turnLabelNthZh(Number(timing.turn_index) + 1), AT.turnLabelNthEn(Number(timing.turn_index) + 1))
        : ''
  const runCount = Number(timing.langgraph_run_count) || 0
  const headerNote =
    runCount > 1
      ? biHtml(
          `本轮含 ${runCount} 次 LangGraph run；「主 run」为第一次开跑，合计见下方表格`,
          `This turn has ${runCount} LangGraph runs; primary run is the first; see table for sum`,
        )
      : timing.note_zh
        ? escHtml(String(timing.note_zh))
        : ''
  /** @type {{ zh: string; en: string; ms: number }[]} */
  const metrics = []
  const push = (zh, en, key) => {
    const v = timing[key]
    if (v != null && Number.isFinite(Number(v))) {
      metrics.push({ zh, en, ms: Number(v) })
    }
  }
  if (timing.page_round_trip_ms != null) {
    push('整轮（页面）', 'Page round-trip', 'page_round_trip_ms')
    push('首字（页面）', 'Page TTFT', 'page_time_to_first_token_ms')
    push('Gateway SSE', 'Gateway SSE', 'gateway_stream_wall_ms')
    push('客户端预检', 'Client preflight', 'preflight_and_client_to_gateway_ms')
  }
  push('用户轮次墙钟', 'Turn wall (user)', 'turn_wall_ms')
  push('开跑前空档', 'Idle before run', 'idle_before_first_run_ms')
  push('run 间最大空档', 'Max inter-run gap', 'max_inter_run_gap_ms')
  push('Run 墙钟（主 run）', 'Primary run wall', 'langgraph_run_wall_ms')
  if (timing.langgraph_run_wall_sum_ms != null) {
    push('Run 墙钟（合计）', 'All runs wall sum', 'langgraph_run_wall_sum_ms')
  }
  push('进模型前', 'Pre-model', 'pre_first_model_ms')
  push('进模型前（实测）', 'Pre-model (measured)', 'pre_model_measured_ms')
  push('主模型 HTTP', 'Main vendor HTTP', 'main_model_vendor_ms')
  push('厂商合计', 'Vendor sum', 'vendor_sum_ms')
  push('Run 内非厂商', 'Non-vendor (est.)', 'non_vendor_estimated_ms')

  const byKind =
    timing.vendor_by_kind_ms && typeof timing.vendor_by_kind_ms === 'object'
      ? timing.vendor_by_kind_ms
      : {}
  const collab =
    timing.collab_phase_ms && typeof timing.collab_phase_ms === 'object' ? timing.collab_phase_ms : {}
  const phases =
    timing.pre_model_breakdown_ms && typeof timing.pre_model_breakdown_ms === 'object'
      ? timing.pre_model_breakdown_ms
      : {}

  if (!metrics.length && !Object.keys(byKind).length && !Object.keys(phases).length && !Object.keys(collab).length) {
    return `<p class="form-hint agent-trace-timing-empty">${biHtml('暂无耗时数据。请重启 Gateway/LangGraph 后发一条新消息。', 'No timing data yet. Restart services and send a new message.')}</p>`
  }

  const metricHtml = metrics.length
    ? `<div class="agent-trace-timing-metrics">${metrics
        .map(
          (m) =>
            `<div class="agent-trace-timing-metric"><span class="agent-trace-timing-metric-k">${biHtml(m.zh, m.en)}</span><strong class="agent-trace-timing-metric-v mono">${escHtml(formatDurationSec(m.ms))}</strong></div>`,
        )
        .join('')}</div>`
    : ''

  const table = (titleZh, titleEn, rows) => {
    if (!rows.length) return ''
    return `<div class="agent-trace-wall-clock-table-wrap"><div class="agent-trace-eyebrow">${biHtml(titleZh, titleEn)}</div><table class="agent-trace-wall-clock-table"><thead><tr><th>${biHtml('项', 'Item')}</th><th>${biHtml('耗时', 'Duration')}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
  }

  const kindRows = Object.entries(byKind)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(
      ([k, ms]) =>
        `<tr><td>${escHtml(formatInvocationKindLabel(k))}</td><td class="mono">${escHtml(formatDurationSec(ms))}</td></tr>`,
    )
  const phaseRows = Object.entries(phases)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([k, ms]) => `<tr><td class="mono">${escHtml(k)}</td><td class="mono">${escHtml(formatDurationSec(ms))}</td></tr>`)
  const collabRows = Object.entries(collab)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([k, ms]) => `<tr><td class="mono">${escHtml(k)}</td><td class="mono">${escHtml(formatDurationSec(ms))}</td></tr>`)

  const interGaps = asArray(timing.inter_run_gaps_in_turn_ms)
  const gapRows = interGaps
    .map((g) => {
      if (!g || typeof g !== 'object') return ''
      const ms = g.gap_ms
      if (ms == null) return ''
      return `<tr><td class="mono">${escHtml(String(g.after_run_index ?? '?'))}→${escHtml(String(g.before_run_index ?? '?'))}</td><td class="mono">${escHtml(formatDurationSec(ms))}</td></tr>`
    })
    .filter(Boolean)
  const runsInTurn = asArray(timing.langgraph_runs_in_turn)
  const runRows = runsInTurn
    .map((r) => {
      if (!r || typeof r !== 'object') return ''
      const wall = r.wall_ms
      if (wall == null) return ''
      const idx = r.run_index != null ? String(r.run_index) : '?'
      return `<tr><td class="mono">#${escHtml(idx)}</td><td class="mono">${escHtml(formatDurationSec(wall))}</td></tr>`
    })
    .filter(Boolean)

  return `<div class="agent-trace-timing-panel">
    <div class="agent-trace-eyebrow agent-trace-eyebrow--i18n">${biHtml('本轮耗时', 'Turn timing')}${turnLabel ? ` · ${escHtml(turnLabel)}` : ''}</div>
    ${headerNote ? `<p class="form-hint agent-trace-timing-hint">${headerNote}</p>` : ''}
    ${metricHtml}
    ${table('本轮 LangGraph run', 'LangGraph runs in turn', runRows)}
    ${table('本轮 run 间空档', 'Inter-run gaps', gapRows)}
    ${table('厂商按用途', 'Vendor by kind', kindRows)}
    ${table('进模型前分段', 'Pre-model phases', phaseRows)}
    ${table('协作阶段（按 model 步）', 'Collab by model step', collabRows)}
  </div>`
}

/**
 * 按轮次汇总 ui_messages AI 行的输入/输出 token（优先 model_call_seq 对应行，否则按全局 cycle 序推断）
 * @param {Record<string, unknown>} payload
 * @param {Record<string, unknown>} turn
 * @param {unknown[]} turnsAll
 * @param {number} turnIdx
 */
function turnTokenInputOutputSums(payload, turn, turnsAll, turnIdx) {
  const tu = payload.token_usage_debug
  if (!tu || typeof tu !== 'object' || !tu.fetch_ok) return { in: null, out: null }
  const rows = asArray(tu.ui_messages_ai_rows)
  if (!rows.length) return { in: null, out: null }
  const cycles = asArray(turn.model_cycles)
  if (!cycles.length) return { in: null, out: null }
  let sumIn = 0
  let sumOut = 0
  let any = false
  const used = new Set()
  for (let j = 0; j < cycles.length; j++) {
    const cy = cycles[j]
    if (!cy || typeof cy !== 'object') continue
    const c = /** @type {Record<string, unknown>} */ (cy)
    const seq = c.model_call_seq
    let globalIdx0
    if (seq != null && Number.isFinite(Number(seq)) && Number(seq) >= 1) {
      globalIdx0 = Math.floor(Number(seq)) - 1
    } else {
      let prior = 0
      for (let t = 0; t < turnIdx; t++) {
        const tt = turnsAll[t]
        if (tt && typeof tt === 'object') prior += asArray(/** @type {Record<string, unknown>} */ (tt).model_cycles).length
      }
      globalIdx0 = prior + j
    }
    if (globalIdx0 == null || globalIdx0 < 0 || globalIdx0 >= rows.length || used.has(globalIdx0)) continue
    used.add(globalIdx0)
    const row = /** @type {Record<string, unknown>} */ (rows[globalIdx0])
    const t = tokenCountsFromUsageDebugRow(row)
    if (!t) continue
    const pi = t.in != null ? Number.parseInt(String(t.in), 10) : Number.NaN
    const po = t.out != null ? Number.parseInt(String(t.out), 10) : Number.NaN
    if (Number.isFinite(pi)) {
      sumIn += pi
      any = true
    }
    if (Number.isFinite(po)) {
      sumOut += po
      any = true
    }
  }
  return any ? { in: sumIn, out: sumOut } : { in: null, out: null }
}

const _MCB_TOOLS_MAX = 220

/**
 * ??????Token ??/?? + ?????????????????
 * @param {HTMLElement} rightEl
 * @param {Record<string, unknown>} payload
 * @param {{ cycleNum: number | null }} seg
 * @param {number} nEv
 */
function appendModelCycleFoldTokenAndNodesRight(rightEl, payload, seg, nEv) {
  const na = biText(AT.modelCycleBannerTokenNAZh, AT.modelCycleBannerTokenNAEn)
  const cyNum = seg.cycleNum
  let tokIn = na
  let tokOut = na
  const tu = payload && typeof payload === 'object' ? payload.token_usage_debug : null
  if (tu && typeof tu === 'object' && tu.fetch_ok && cyNum != null && cyNum >= 1) {
    const rows = asArray(tu.ui_messages_ai_rows)
    const row = /** @type {Record<string, unknown> | undefined} */ (rows[cyNum - 1])
    const t = tokenCountsFromUsageDebugRow(row)
    if (t) {
      tokIn = t.in != null ? t.in : na
      tokOut = t.out != null ? t.out : na
    }
  }

  const tokChunk = document.createElement('span')
  tokChunk.className = 'agent-trace-mcb-chunk agent-trace-mcb-chunk--nowrap'
  const k1 = document.createElement('span')
  k1.className = 'agent-trace-mcb-k'
  k1.textContent = `${biText(AT.modelCycleBannerTokenInZh, AT.modelCycleBannerTokenInEn)} `
  const v1 = document.createElement('span')
  v1.className = 'agent-trace-mcb-v'
  v1.textContent = tokIn
  const k2 = document.createElement('span')
  k2.className = 'agent-trace-mcb-k'
  k2.textContent = ` ${biText(AT.modelCycleBannerTokenOutZh, AT.modelCycleBannerTokenOutEn)} `
  const v2 = document.createElement('span')
  v2.className = 'agent-trace-mcb-v'
  v2.textContent = tokOut
  tokChunk.appendChild(k1)
  tokChunk.appendChild(v1)
  tokChunk.appendChild(k2)
  tokChunk.appendChild(v2)
  rightEl.appendChild(tokChunk)

  const dot = document.createElement('span')
  dot.className = 'agent-trace-mcb-sep'
  dot.textContent = MID_DOT
  rightEl.appendChild(dot)

  const meta = document.createElement('span')
  meta.className = 'agent-trace-model-cycle-fold-meta agent-trace-model-cycle-fold-meta--inline'
  meta.lang = 'zh-CN'
  meta.textContent = biText(AT.modelCycleFoldMetaZh(nEv), AT.modelCycleFoldMetaEn(nEv))
  rightEl.appendChild(meta)
}

/**
 * ?????? + ??????? Token??
 * @param {HTMLElement} titleCol
 * @param {Record<string, unknown>} turn
 * @param {{ cycleNum: number | null }} seg
 */
function appendModelCycleFoldScenarioToolsRow(titleCol, turn, seg) {
  const scenarios = scenariosLabelForCycle(turn, seg)
  const cyNum = seg.cycleNum
  const cycles = asArray(turn.model_cycles)
  const na = biText(AT.modelCycleBannerTokenNAZh, AT.modelCycleBannerTokenNAEn)
  let toolsStr = na
  if (cyNum == null || cyNum < 1) {
    toolsStr = na
  } else {
    const cy = cycles[cyNum - 1]
    if (cy && typeof cy === 'object') {
      const c = /** @type {Record<string, unknown>} */ (cy)
      const tools = asStringList(c.model_request_tools)
      if (tools.length) {
        const j = tools.join(LIST_SEP)
        toolsStr = j.length > _MCB_TOOLS_MAX ? j.slice(0, _MCB_TOOLS_MAX - 1) + '\u2026' : j
      } else if (c.model_request_tools_count != null && Number(c.model_request_tools_count) > 0) {
        toolsStr = biText(AT.kf.unitCountZh(Number(c.model_request_tools_count)), '')
      } else {
        toolsStr = na
      }
    }
  }

  const el = document.createElement('div')
  el.className = 'agent-trace-model-cycle-fold-metrics'
  el.setAttribute('lang', 'zh-CN')

  const addChunk = (labelZh, labelEn, valueText) => {
    const sp = document.createElement('span')
    sp.className = 'agent-trace-mcb-chunk'
    const k = document.createElement('span')
    k.className = 'agent-trace-mcb-k'
    k.textContent = `${biText(labelZh, labelEn)} `
    const val = document.createElement('span')
    val.className = 'agent-trace-mcb-v'
    val.textContent = valueText
    sp.appendChild(k)
    sp.appendChild(val)
    return sp
  }
  const addSep = () => {
    const s = document.createElement('span')
    s.className = 'agent-trace-mcb-sep'
    s.textContent = MID_DOT
    return s
  }

  el.appendChild(addChunk(AT.modelCycleBannerScenarioZh, AT.modelCycleBannerScenarioEn, scenarios))
  el.appendChild(addSep())
  el.appendChild(addChunk(AT.modelCycleBannerToolsZh, AT.modelCycleBannerToolsEn, toolsStr))
  titleCol.appendChild(el)
}

/**
 * @param {HTMLElement} tl
 * @param {Record<string, unknown>} ev ??????? kind / t / subtitle / data / phaseKey / cycleIndex?
 * @param {{ current: string | null; lastRailPhaseKey: string | null }} phaseCarry
 * @param {{ hideCycleBanner?: boolean }} railOpts
 */
function appendTimelineEventRow(tl, ev, phaseCarry, railOpts) {
  const d = ev.data
  if (d && typeof d === 'object') {
    const o = /** @type {Record<string, unknown>} */ (d)
    const eff = effectiveCollabPhaseFromRow(o)
    if (eff) {
      phaseCarry.current = eff.toLowerCase() === 'idle' ? null : eff
    } else {
      const cpOnly =
        o.collab_phase != null && String(o.collab_phase).trim() ? String(o.collab_phase).trim() : ''
      if (cpOnly.toLowerCase() === 'idle') phaseCarry.current = null
    }
  }

  const row = document.createElement('div')
  row.className = 'agent-trace-tl-row'

  const rail = document.createElement('div')
  rail.className = 'agent-trace-tl-rail'
  const railTop = document.createElement('div')
  railTop.className = 'agent-trace-tl-rail-top'
  const dot = document.createElement('span')
  const pk = /** @type {{ phaseKey?: string }} */ (ev).phaseKey || 'phase_other'
  dot.className = `agent-trace-tl-dot ${phaseKeyToDotClass(pk)}`
  dot.setAttribute('aria-hidden', 'true')
  railTop.appendChild(dot)
  const phaseRail = timelineRailPhaseText(ev, phaseCarry, railOpts)
  if (phaseRail) {
    const ph = document.createElement('div')
    ph.className = 'agent-trace-tl-rail-phase'
    ph.lang = 'zh-CN'
    ph.textContent = phaseRail
    railTop.appendChild(ph)
  }
  if (ev.durationMs != null && Number.isFinite(Number(ev.durationMs))) {
    const dur = document.createElement('span')
    dur.className = 'agent-trace-tl-duration-badge mono'
    dur.textContent = formatDurationSec(ev.durationMs)
    railTop.appendChild(dur)
  }
  rail.appendChild(railTop)
  const railTime = document.createElement('div')
  railTime.className = 'agent-trace-tl-rail-time'
  railTime.lang = 'zh-CN'
  const tsShown = formatMs(ev.t)
  const timeCode = document.createElement('code')
  timeCode.className = 'agent-trace-tl-rail-time-code'
  timeCode.textContent = tsShown
  railTime.appendChild(timeCode)
  rail.appendChild(railTime)
  const line = document.createElement('span')
  line.className = 'agent-trace-tl-line'
  rail.appendChild(line)
  row.appendChild(rail)

  const body = document.createElement('div')
  body.className = 'agent-trace-tl-body'

  const card = document.createElement('div')
  card.className = 'agent-trace-tl-card'

  const titleRaw = ev.title != null ? String(ev.title).trim() : ''
  const subRaw = ev.subtitle != null ? String(ev.subtitle).trim() : ''
  const isToolCard = ev.kind === 'tool'
  const subDistinct = subRaw && subRaw !== tsShown

  if (titleRaw || (isToolCard && subDistinct)) {
    const head = document.createElement('div')
    head.className = 'agent-trace-tl-card-head'
    if (titleRaw) {
      const tit = document.createElement('div')
      tit.className = 'agent-trace-tl-card-title'
      tit.lang = 'zh-CN'
      tit.textContent = titleRaw
      head.appendChild(tit)
    }
    if (isToolCard && subDistinct) {
      const meta = document.createElement('div')
      meta.className = 'agent-trace-tl-card-head-meta'
      meta.lang = 'zh-CN'
      meta.textContent = subRaw
      head.appendChild(meta)
    }
    card.appendChild(head)
  }

  if (!isToolCard && subDistinct) {
    const sub = document.createElement('div')
    sub.className = 'agent-trace-tl-card-sub'
    const subMore = document.createElement('div')
    subMore.className = 'agent-trace-tl-card-sub-more'
    subMore.textContent = subRaw
    sub.appendChild(subMore)
    card.appendChild(sub)
  }

  renderTimelineKeyFacts(card, ev)

  const expandable = document.createElement('div')
  expandable.className = 'agent-trace-tl-card-expand'
  renderTimelineCardBody(expandable, ev)
  if (expandable.childNodes.length > 0) card.appendChild(expandable)

  body.appendChild(card)
  row.appendChild(body)
  tl.appendChild(row)
}

/**
 * ?????????????????????????????????????????/?? JSON ??????
 * @param {HTMLElement} card
 * @param {{ kind: string; data?: unknown }} ev
 */
function renderTimelineKeyFacts(card, ev) {
  const data = ev.data
  if (!data || typeof data !== 'object') return
  const parts = []
  const kind = ev.kind
  const K = AT.kf

  if (kind === 'model_call') {
    const tools = asStringList(data.model_request_tools)
    const def = asStringList(data.loaded_deferred_tools)
    const cnt = data.model_request_tools_count
    if (tools.length) parts.push({ k: biText(K.toolListZh, 'Tools'), v: tools.join(LIST_SEP) })
    else if (cnt != null && Number(cnt) > 0)
      parts.push({ k: biText(K.attachedToolsZh, 'Attached'), v: biText(K.unitCountZh(Number(cnt)), '') })
    else parts.push({ k: biText(K.toolListZh, 'Tools'), v: biText(K.noneZh, 'None') })
    if (def.length) parts.push({ k: biText(K.deferredToolsZh, 'Deferred'), v: def.join(LIST_SEP) })
    const ui = data.user_input != null ? String(data.user_input).trim() : ''
    if (ui) parts.push({ k: biText(K.userInputZh, 'User'), v: trunc(ui, 280) })
  } else if (kind === 'collab') {
    const evn = String(data.event || '')
    const effPh = effectiveCollabPhaseFromRow(/** @type {Record<string, unknown>} */ (data))
    const effNorm = effPh ? effPh.toLowerCase() : ''
    const setp = data.set_collab_phase != null && String(data.set_collab_phase).trim() ? String(data.set_collab_phase).trim() : ''
    const toP = data.to_phase != null && String(data.to_phase).trim() ? String(data.to_phase).trim() : ''
    const setDiff = setp && (!effNorm || setp.toLowerCase() !== effNorm)
    const toDiff = toP && (!effNorm || toP.toLowerCase() !== effNorm)
    if (setDiff) parts.push({ k: biText(K.writePhaseZh, 'Write phase'), v: collabPhaseLabelZh(setp) })
    if (toDiff && (!setp || toP.toLowerCase() !== setp.toLowerCase()))
      parts.push({ k: biText(K.targetPhaseZh, 'Target phase'), v: collabPhaseLabelZh(toP) })
    if (data.source != null && String(data.source).trim())
      parts.push({ k: biText(K.sourceZh, 'Source'), v: String(data.source) })
    if (evn === 'model_request') {
      const tools = asStringList(data.model_request_tools)
      const n = data.model_request_tools_count
      if (tools.length) parts.push({ k: biText(K.requestToolListZh, 'Request tools'), v: tools.join(LIST_SEP) })
      else if (n != null) parts.push({ k: biText(K.attachedToolCountZh, 'Tool count'), v: biText(K.unitCountZh(Number(n)), '') })
    } else if (evn === 'before_model') {
      if (data.message_count != null) parts.push({ k: biText(AT.meta.msgCountZh, AT.meta.msgCountEn), v: String(data.message_count) })
      if (data.last_message_type) parts.push({ k: biText(K.lastMsgTypeZh, 'Last msg type'), v: String(data.last_message_type) })
      const lup = data.last_user_preview != null ? String(data.last_user_preview).trim() : ''
      if (lup) parts.push({ k: biText(K.userPreviewZh, 'User preview'), v: trunc(lup, 420) })
    } else if (evn === 'model_response') {
      const rt = asStringList(data.response_tool_calls)
      if (rt.length) parts.push({ k: biText(K.responseToolCallsZh, 'Response tools'), v: rt.join(LIST_SEP) })
      if (data.elapsed_ms != null) parts.push({ k: biText(K.elapsedZh, 'Elapsed'), v: formatDurationSec(data.elapsed_ms) })
      const ap = data.ai_preview != null ? String(data.ai_preview).trim() : ''
      if (ap) parts.push({ k: biText(K.aiPreviewZh, 'AI preview'), v: trunc(ap, 520) })
      if (data.invalid_tool_calls_count != null && Number(data.invalid_tool_calls_count) > 0)
        parts.push({ k: biText(K.invalidToolCallsZh, 'Invalid tool_calls'), v: String(data.invalid_tool_calls_count) })
    } else if (evn === 'after_model') {
      const ft = asStringList(data.final_ai_tool_calls)
      if (ft.length) parts.push({ k: biText(K.finalAiToolCallsZh, 'Final AI tool_calls'), v: ft.join(LIST_SEP) })
      const fp = data.final_ai_preview != null ? String(data.final_ai_preview).trim() : ''
      if (fp) parts.push({ k: biText(K.finalAiPreviewZh, 'Final AI preview'), v: trunc(fp, 620) })
    } else if (evn === 'tool_start') {
      if (data.tool_name) parts.push({ k: biText(K.toolZh, 'Tool'), v: String(data.tool_name) })
      if (data.tool_call_id) parts.push({ k: 'tool_call_id', v: trunc(String(data.tool_call_id), 56) })
    } else if (evn === 'tool_end') {
      if (data.tool_name) parts.push({ k: biText(K.toolZh, 'Tool'), v: String(data.tool_name) })
      if (data.elapsed_ms != null) parts.push({ k: biText(K.elapsedZh, 'Elapsed'), v: formatDurationSec(data.elapsed_ms) })
      if (data.result_type) parts.push({ k: biText(K.resultTypeZh, 'Result type'), v: String(data.result_type) })
      const rp = data.result_preview != null ? String(data.result_preview).trim() : ''
      if (rp) parts.push({ k: biText(K.resultPreviewZh, 'Result preview'), v: trunc(rp, 900) })
    } else {
      const skip = new Set(['ts', 'timestamp', 'thread_id', 'event', 'collab_phase', 'set_collab_phase', 'to_phase', 'from_phase', 'source'])
      for (const k of Object.keys(data)) {
        if (skip.has(k)) continue
        const v = data[k]
        if (v == null || typeof v === 'object') continue
        parts.push({ k, v: trunc(String(v), 220) })
        if (parts.length >= 10) break
      }
    }
  } else if (kind === 'lifecycle') {
    if (data.event) parts.push({ k: biText(K.eventZh, 'Event'), v: String(data.event) })
    if (data.status) parts.push({ k: biText(K.statusZh, 'Status'), v: String(data.status) })
    if (data.main_task_id) parts.push({ k: biText(K.mainTaskZh, 'Main task'), v: String(data.main_task_id) })
    if (data.subtask_id) parts.push({ k: biText(K.subtaskZh, 'Subtask'), v: String(data.subtask_id) })
  } else if (kind === 'model_http') {
    const rec = /** @type {Record<string, unknown>} */ (data)
    const ik = resolveInvocationKindFromRecord(rec)
    parts.push({
      k: biText(AT.meta.invocationKindZh, AT.meta.invocationKindEn),
      v: formatInvocationKindLabel(ik),
    })
    const mid = rec.model != null && String(rec.model).trim() ? String(rec.model).trim() : EM_DASH
    parts.push({ k: biText(AT.meta.modelIdZh, AT.meta.modelIdEn), v: mid })
    const turns = payloadContextUserTurnCount(rec)
    parts.push({ k: biText(AT.meta.contextTurnsZh, AT.meta.contextTurnsEn), v: turns != null ? String(turns) : EM_DASH })
    const pl = rec.payload
    const think = inferThinkingEnabledFromPayload(pl && typeof pl === 'object' ? pl : null)
    parts.push({ k: biText(AT.meta.thinkingEnabledZh, AT.meta.thinkingEnabledEn), v: formatThinkingLabel(think) })
    const tnames = toolNamesFromVendorPayload(pl && typeof pl === 'object' ? pl : null)
    parts.push({ k: biText(AT.meta.requestToolsListZh, AT.meta.requestToolsListEn), v: tnames.length ? tnames.join(LIST_SEP) : EM_DASH })
    const vlat = rec.vendor_latency_ms
    if (vlat != null && Number.isFinite(Number(vlat)))
      parts.push({
        k: biText(AT.meta.vendorRoundtripLatencyZh, AT.meta.vendorRoundtripLatencyEn),
        v: formatDurationSec(vlat),
      })
    if (rec.vendor_response != null)
      parts.push({
        k: biText(AT.detailKeys.vendorResponseZh, AT.detailKeys.vendorResponseEn),
        v: biText(AT.modelHttpHasResponseShortZh, AT.modelHttpHasResponseShortEn),
      })
  } else if (kind === 'tool') {
    const rec = /** @type {Record<string, unknown>} */ (data)
    const toolKfMax = 200000
    if (rec.input != null) parts.push({ k: biText(AT.detailKeys.toolInputZh, AT.detailKeys.toolInputEn), v: safeJsonPreview(rec.input, toolKfMax) })
    if (rec.output != null) parts.push({ k: biText(AT.detailKeys.toolOutputZh, AT.detailKeys.toolOutputEn), v: safeJsonPreview(rec.output, toolKfMax) })
  } else if (kind === 'round') {
    const ui = data.user_input != null ? String(data.user_input).trim() : ''
    if (ui) parts.push({ k: biText(K.userInputZh, 'User'), v: trunc(ui, 320) })
    const tools = asStringList(data.model_request_tools)
    if (tools.length) parts.push({ k: biText(K.toolListZh, 'Tools'), v: tools.join(LIST_SEP) })
    if (data.model_request_tools_count != null) parts.push({ k: biText(K.toolCountZh, 'Tool count'), v: String(data.model_request_tools_count) })
  }

  if (!parts.length) return

  const box = document.createElement('div')
  box.className = 'agent-trace-tl-keyfacts'
  box.innerHTML = parts
    .map((p) => {
      const multiline = p.v.includes('\n') || p.v.length > 140
      if (multiline) {
        return `<div class="agent-trace-kf-block"><div class="agent-trace-kf-k">${escHtml(p.k)}</div><pre class="agent-trace-kf-pre" lang="zh-CN">${escHtml(p.v)}</pre></div>`
      }
      return `<div class="agent-trace-kf-row"><span class="agent-trace-kf-k">${escHtml(p.k)}</span><span class="agent-trace-kf-v">${escHtml(p.v)}</span></div>`
    })
    .join('')
  card.appendChild(box)
}

/**
 * ?????????????????????????? ? ??/?? ? ?? ? ?? ? ?? ???
 * @param {Record<string, unknown>} turn
 * @param {Record<string, unknown>} payload
 * @param {Record<string, unknown>} [timing]
 */
function buildTurnTimelineEvents(turn, payload, timing) {
  const startMs = Number.isFinite(Number(turn.start_ms)) ? Number(turn.start_ms) : 0
  const endMs =
    turn.end_ms != null && Number.isFinite(Number(turn.end_ms)) ? Number(turn.end_ms) : null
  const snap = turn.turn_snapshot && typeof turn.turn_snapshot === 'object' ? turn.turn_snapshot : null
  const userT = epochMsFromAny(snap?.timestamp) ?? startMs
  const cycleWindows = buildModelCycleWindows(turn)
  /** @type {Array<{ t: number; ord: number; kind: string; title: string; subtitle?: string; data?: unknown; cycleIndex?: number | null; phaseKey: string }>} */
  const events = []
  let ord = 0

  const userDur =
    timing?.page_round_trip_ms != null
      ? formatDurationSec(timing.page_round_trip_ms)
      : timing?.turn_wall_ms != null
        ? formatDurationSec(timing.turn_wall_ms)
        : null
  events.push({
    t: userT,
    ord: ord++,
    kind: 'user',
    title: String(turn.label || '').trim() || biText(AT.kf.userInputZh, 'User input'),
    subtitle: userDur ? `${formatMs(userT)} ${MID_DOT} ${userDur}` : formatMs(userT),
    durationMs: timing?.page_round_trip_ms ?? timing?.turn_wall_ms ?? null,
    data: { user_input: turn.user_input, activated_scenarios: turn.activated_scenarios, snap },
    cycleIndex: null,
    phaseKey: 'phase_user',
  })

  /** @type {Array<{ t: number; row: Record<string, unknown>; evn: string }>} */
  const collabBuf = []
  asArray(turn.collab_cycle_indices).forEach((ci) => {
    const row = asArray(payload.collab_cycle)[ci]
    if (!row || typeof row !== 'object') return
    const evn = String(row.event || 'event')
    const evnLo = evn.trim().toLowerCase()
    if (evnLo === 'tool_start' || evnLo === 'tool_end') return
    const ts = epochMsFromAny(row.ts ?? row.timestamp) ?? userT
    collabBuf.push({ t: ts, row: /** @type {Record<string, unknown>} */ (row), evn })
  })
  collabBuf.sort((a, b) => a.t - b.t)
  const collabPhaseMs =
    timing?.collab_phase_ms && typeof timing.collab_phase_ms === 'object' ? timing.collab_phase_ms : {}
  let prevCollabTs = null
  let prevCollabEv = ''
  collabBuf.forEach(({ t: ts, row, evn }) => {
    const evnLo = evn.trim().toLowerCase()
    let gapMs = null
    if (prevCollabTs != null && prevCollabEv && evnLo) {
      const key = `${prevCollabEv}_to_${evnLo}_ms`
      if (collabPhaseMs[key] != null) gapMs = Number(collabPhaseMs[key])
      else gapMs = ts - prevCollabTs
    }
    const subParts = [formatMs(ts)]
    if (gapMs != null && Number.isFinite(gapMs) && gapMs >= 0) {
      subParts.push(`+${formatDurationSec(gapMs)}`)
    }
    events.push({
      t: ts,
      ord: ord++,
      kind: 'collab',
      title: collabGraphStageLabelZh(evn),
      subtitle: subParts.join(` ${MID_DOT} `),
      durationMs: gapMs,
      data: row,
      cycleIndex: cycleIndexFromTs(cycleWindows, ts),
      phaseKey: eventPhaseKey({ kind: 'collab', data: row }),
    })
    prevCollabTs = ts
    prevCollabEv = evnLo
  })

  asArray(payload.task_lifecycle_trace).forEach((row) => {
    if (!row || typeof row !== 'object') return
    const ts = epochMsFromAny(row.ts ?? row.timestamp)
    if (!inTurnWindow(ts, startMs, endMs)) return
    const tEff = ts != null ? ts : userT
    events.push({
      t: tEff,
      ord: ord++,
      kind: 'lifecycle',
      title: `${biText(AT.prefixes.lifecycleZh, AT.prefixes.lifecycleEn)} ${MID_DOT} ${String(row.event || '').slice(0, 72)}`,
      subtitle: [row.main_task_id, row.subtask_id, row.status].filter(Boolean).join(' ${MID_DOT} ') || formatMs(ts),
      data: row,
      cycleIndex: cycleIndexFromTs(cycleWindows, tEff),
      phaseKey: eventPhaseKey({ kind: 'lifecycle', data: row }),
    })
  })

  asArray(payload.lead_agent_round).forEach((row) => {
    if (!row || typeof row !== 'object') return
    const ts = epochMsFromAny(row.timestamp)
    if (!inTurnWindow(ts, startMs, endMs)) return
    const evName = String(row.event || '')
    if (evName === 'turn_snapshot' && ts != null && Math.abs(ts - userT) < 3) return
    const tEff = ts != null ? ts : userT
    if (evName === 'model_call_tools') {
      const cyc =
        cycleIndexFromModelCallSeq(turn, row.model_call_seq) ?? cycleIndexFromTs(cycleWindows, tEff)
      events.push({
        t: tEff,
        ord: ord++,
        kind: 'model_call',
        title: `${biText(AT.prefixes.modelCallZh, AT.prefixes.modelCallEn)} ${MID_DOT} ${row.model_call_seq != null ? row.model_call_seq : '?'}`,
        subtitle:
          row.model_request_tools_count != null
            ? biText(
                AT.subtitles.toolsInTurnZh(row.model_request_tools_count),
                AT.subtitles.toolsInTurnEn(row.model_request_tools_count),
              )
            : formatMs(ts),
        data: row,
        cycleIndex: cyc,
        phaseKey: eventPhaseKey({ kind: 'model_call', data: row }),
      })
      return
    }
    events.push({
      t: tEff,
      ord: ord++,
      kind: 'round',
      title: `${biText(AT.prefixes.roundZh, AT.prefixes.roundEn)} ${MID_DOT} ${evName || 'record'}`,
      subtitle: formatMs(ts),
      data: row,
      cycleIndex: cycleIndexFromTs(cycleWindows, tEff),
      phaseKey: eventPhaseKey({ kind: 'round', data: row }),
    })
  })

  const seenM = new Set()
  asArray(turn.model_cycles).forEach((cy, cyIdx) => {
    const cycNum = cyIdx + 1
    asArray(cy.model_request_payload_indices).forEach((mi) => {
      if (seenM.has(mi)) return
      seenM.add(mi)
      const rec = asArray(payload.model_request_payloads)[mi]
      if (!rec || typeof rec !== 'object') return
      const ts =
        epochMsFromAny(rec.ts_ms) ??
        epochMsFromAny(cy.timestamp_ms ?? cy.timestamp) ??
        userT
      const modelStr = rec.model != null && String(rec.model).trim() ? String(rec.model).trim() : '?'
      const kind = resolveInvocationKindFromRecord(rec)
      const kindLabel = formatInvocationKindLabel(kind)
      const vLat = rec.vendor_latency_ms
      const subParts = [formatMs(ts)]
      if (vLat != null && Number.isFinite(Number(vLat))) {
        subParts.push(formatDurationSec(vLat))
      }
      events.push({
        t: ts,
        ord: ord++,
        kind: 'model_http',
        title: `${biText(AT.modelHttpDebugTitleZh, AT.modelHttpDebugTitleEn)} ${MID_DOT} ${kindLabel} ${MID_DOT} ${modelStr}`,
        subtitle: subParts.join(` ${MID_DOT} `),
        durationMs: vLat != null && Number.isFinite(Number(vLat)) ? Number(vLat) : null,
        data: rec,
        cycleIndex: cycNum,
        phaseKey: eventPhaseKey({ kind: 'model_http', data: rec }),
      })
    })
  })

  const seenT = new Set()
  asArray(turn.model_cycles).forEach((cy, cyIdx) => {
    const cycNum = cyIdx + 1
    asArray(cy.tool_call_io_indices).forEach((ti) => {
      if (seenT.has(ti)) return
      seenT.add(ti)
      const rec = asArray(payload.tool_call_io)[ti]
      if (!rec || typeof rec !== 'object') return
      const ts = epochMsFromAny(rec.timestamp) ?? userT
      const st = rec.status != null ? String(rec.status) : ''
      events.push({
        t: ts,
        ord: ord++,
        kind: 'tool',
        title: `${biText(AT.prefixes.toolZh, AT.prefixes.toolEn)} ${MID_DOT} ${rec.tool_name || 'unknown'}`,
        subtitle: `${st || EM_DASH}${rec.duration_ms != null ? ` ${MID_DOT} ${formatDurationSec(rec.duration_ms)}` : ''}`,
        data: rec,
        cycleIndex: cycNum,
        phaseKey: eventPhaseKey({ kind: 'tool', data: rec }),
      })
    })
  })

  const pri = (k) =>
    ({ user: 0, lifecycle: 1, collab: 2, model_call: 3, model_http: 4, tool: 5, round: 6 }[k] ?? 7)

  events.sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t
    const d = pri(a.kind) - pri(b.kind)
    if (d !== 0) return d
    return a.ord - b.ord
  })

  return events
}

/** @param {Record<string, unknown>} turn */
function turnOverviewStats(turn) {
  const cycles = asArray(turn.model_cycles)
  let toolCalls = 0
  let modelRequests = 0
  cycles.forEach((cy) => {
    if (!cy || typeof cy !== 'object') return
    const c = /** @type {Record<string, unknown>} */ (cy)
    toolCalls += asArray(c.tool_call_io_indices).length
    modelRequests += asArray(c.model_request_payload_indices).length
  })
  return {
    modelCycles: cycles.length,
    toolCalls,
    modelRequests,
    collab: asArray(turn.collab_cycle_indices).length,
  }
}

/** @param {HTMLElement} el @param {Record<string, unknown>} payload @param {number} turnIndex */
function renderTurnSummary(el, payload, turnIndex = 0) {
  const ct = payload.conversation_turns || {}
  const turns = asArray(ct.turns)
  const cnt = ct.counts || {}

  if (!turns.length) {
    el.innerHTML = `<p class="form-hint agent-trace-turn-empty">${biHtml(AT.noTurnDataZh, AT.noTurnDataEn)}</p>`
    return
  }

  const idx = Math.min(Math.max(0, turnIndex), turns.length - 1)
  const turn = /** @type {Record<string, unknown>} */ (turns[idx])
  const stats = turnOverviewStats(turn)
  const label =
    String(turn.label || '').trim() ||
    biText(AT.turnLabelNthZh(idx + 1), AT.turnLabelNthEn(idx + 1))
  const startMs = turn.start_ms
  const endMs = turn.end_ms
  const timeRange =
    startMs != null && Number.isFinite(Number(startMs))
      ? `${formatMs(startMs)}${endMs != null && Number.isFinite(Number(endMs)) ? ` ${MID_DOT} ${formatMs(endMs)}` : ''}`
      : EM_DASH
  const ui = turn.user_input != null ? String(turn.user_input).trim() : ''
  const sc = turn.activated_scenarios
  let scDisplay = EM_DASH
  if (Array.isArray(sc) && sc.length) {
    scDisplay = sc.map((x) => String(x)).filter(Boolean).join(LIST_SEP)
  } else if (typeof sc === 'string' && sc.trim()) {
    scDisplay = sc.trim()
  }

  const timing = getTurnTiming(turn, payload, idx)
  const wallMs = timing.turn_wall_ms ?? turnWallDurationMs(turn)
  const vendorSumMs = timing.vendor_sum_ms ?? turnVendorLatencySumMs(payload, turn)
  const tokSums = turnTokenInputOutputSums(payload, turn, turns, idx)

  /** @type {{ zh: string; en: string; v: string | number }[]} */
  const leadMetrics = []
  if (timing.page_round_trip_ms != null) {
    leadMetrics.push({
      zh: '整轮（页面）',
      en: 'Page round-trip',
      v: formatDurationSec(timing.page_round_trip_ms),
    })
  }
  if (wallMs != null) {
    leadMetrics.push({
      zh: AT.sum.turnWallZh,
      en: AT.sum.turnWallEn,
      v: formatDurationSec(wallMs),
    })
  }
  if (timing.main_model_vendor_ms != null) {
    leadMetrics.push({
      zh: '主模型 HTTP',
      en: 'Main vendor',
      v: formatDurationSec(timing.main_model_vendor_ms),
    })
  }
  if (vendorSumMs != null) {
    leadMetrics.push({
      zh: AT.sum.vendorLatencySumZh,
      en: AT.sum.vendorLatencySumEn,
      v: formatDurationSec(vendorSumMs),
    })
  }
  if (tokSums.in != null) {
    leadMetrics.push({
      zh: AT.sum.tokensInSumZh,
      en: AT.sum.tokensInSumEn,
      v: tokSums.in,
    })
  }
  if (tokSums.out != null) {
    leadMetrics.push({
      zh: AT.sum.tokensOutSumZh,
      en: AT.sum.tokensOutSumEn,
      v: tokSums.out,
    })
  }

  const metrics = [
    ...leadMetrics,
    { zh: '轮次', en: 'Turn', v: `${idx + 1} / ${turns.length}` },
    { zh: AT.sum.modelStepsZh, en: 'Model steps', v: stats.modelCycles },
    { zh: AT.sum.toolCallsZh, en: 'Tool calls', v: stats.toolCalls },
    { zh: AT.sum.vendorRowsZh, en: 'Vendor HTTP rows', v: stats.modelRequests },
    { zh: AT.sum.collabRowsZh, en: 'Collab rows', v: stats.collab },
    { zh: AT.sum.turnsZh, en: 'Session turns', v: cnt.turns ?? turns.length },
  ]
    .map(
      (m) => `
      <div class="agent-trace-sum-metric">
        <div class="agent-trace-sum-dt">${biHtml(m.zh, m.en)}</div>
        <div class="agent-trace-sum-dd"><strong>${escHtml(String(m.v))}</strong></div>
      </div>`,
    )
    .join('')

  el.innerHTML = `
    <div class="agent-trace-summary-card">
      <div class="agent-trace-summary-head">
        <div class="agent-trace-eyebrow agent-trace-eyebrow--i18n">${biHtml(AT.turnOverviewSummaryZh, AT.turnOverviewSummaryEn)}</div>
      </div>
      <div class="agent-trace-turn-summary-label">${escHtml(label)}</div>
      <div class="agent-trace-thread-id-label">${biHtml(AT.threadIdLabelZh, AT.threadIdLabelEn)}</div>
      <div class="mono agent-trace-summary-tid">${escHtml(payload.thread_id || '')}</div>
      <div class="agent-trace-summary-metrics">${metrics}</div>
      <div class="agent-trace-summary-foot">
        <div class="agent-trace-summary-foot-line">${biHtml('时间', 'Time')}: ${escHtml(timeRange)}</div>
        ${ui ? `<div class="agent-trace-summary-foot-line agent-trace-turn-summary-user">${biHtml(AT.kf.userInputZh, 'User')}: ${escHtml(trunc(ui, 280))}</div>` : ''}
        ${scDisplay !== EM_DASH ? `<div class="agent-trace-summary-foot-line">${biHtml(AT.modelCycleBannerScenarioZh, AT.modelCycleBannerScenarioEn)}: ${escHtml(trunc(scDisplay, 120))}</div>` : ''}
        ${renderTurnTimingPanelHtml(timing)}
      </div>
    </div>
  `
}

/** @deprecated use renderTurnTimingPanelHtml(getTurnTiming(...)) */
function renderEndToEndTimingHtml(payload) {
  const e2e = payload.end_to_end_timing
  if (!e2e || typeof e2e !== 'object') return ''
  const segs = e2e.segments_ms && typeof e2e.segments_ms === 'object' ? e2e.segments_ms : {}
  const roundTrip = segs.page_round_trip_ms
  const ttft = segs.page_time_to_first_token_ms
  const gwWall = segs.gateway_stream_wall_ms
  const preModel = segs.pre_model_total_ms
  const lines = []
  if (roundTrip != null) {
    lines.push(
      `<div class="agent-trace-summary-foot-line"><strong>${biHtml('整轮耗时（页面）', 'Page round-trip')}</strong>: ${escHtml(formatDurationSec(roundTrip))}</div>`,
    )
  }
  if (ttft != null) {
    lines.push(
      `<div class="agent-trace-summary-foot-line">${biHtml('首字（页面）', 'Page TTFT')}: ${escHtml(formatDurationSec(ttft))}</div>`,
    )
  }
  if (gwWall != null) {
    lines.push(
      `<div class="agent-trace-summary-foot-line">${biHtml('Gateway SSE', 'Gateway SSE')}: ${escHtml(formatDurationSec(gwWall))}</div>`,
    )
  }
  if (preModel != null) {
    lines.push(
      `<div class="agent-trace-summary-foot-line">${biHtml('进模型前（实测）', 'Pre-model (measured)')}: ${escHtml(formatDurationSec(preModel))}</div>`,
    )
  }
  const phases = e2e.pre_model_breakdown_ms
  let phaseTable = ''
  if (phases && typeof phases === 'object' && Object.keys(phases).length) {
    const rows = Object.entries(phases)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .map(
        ([name, ms]) =>
          `<tr><td class="mono">${escHtml(name)}</td><td class="mono">${escHtml(formatDurationSec(ms))}</td></tr>`,
      )
      .join('')
    phaseTable = `<div class="agent-trace-wall-clock-table-wrap"><div class="agent-trace-eyebrow">${biHtml('进模型前分段', 'Pre-model phases')}</div><table class="agent-trace-wall-clock-table"><thead><tr><th>${biHtml('阶段', 'Phase')}</th><th>${biHtml('耗时', 'Duration')}</th></tr></thead><tbody>${rows}</tbody></table></div>`
  }
  if (!lines.length && !phaseTable) return ''
  return `<div class="agent-trace-e2e-block">${lines.join('')}${phaseTable}</div>`
}

/** @param {Record<string, unknown>} payload */
function renderWallClockBreakdownHtml(payload) {
  const wb = payload.wall_clock_breakdown
  if (!wb || typeof wb !== 'object') return ''
  const byKind = /** @type {Record<string, number>} */ (wb.vendor_by_kind_ms || {})
  const keys = Object.keys(byKind)
  if (!keys.length) return ''
  const rows = keys
    .map((k) => {
      const ms = byKind[k]
      return `<tr><td>${escHtml(formatInvocationKindLabel(k))}</td><td class="mono">${escHtml(formatDurationSec(ms))}</td></tr>`
    })
    .join('')
  const seg = wb.segments_ms && typeof wb.segments_ms === 'object' ? wb.segments_ms : {}
  const wall = seg.langgraph_run_wall
  const pre = seg.pre_first_model
  const hint =
    wall != null
      ? `<div class="agent-trace-summary-foot-line form-hint">${biHtml('Run \u5899\u949f', 'Run wall')}: ${escHtml(formatDurationSec(wall))}${pre != null ? ` \u00b7 ${biHtml('\u8fdb\u6a21\u578b\u524d', 'Pre-model')}: ${escHtml(formatDurationSec(pre))}` : ''}</div>`
      : ''
  return `${hint}<div class="agent-trace-wall-clock-table-wrap"><div class="agent-trace-eyebrow">${biHtml('\u5382\u5546\u8017\u65f6\u6309\u7528\u9014', 'Vendor latency by kind')}</div><table class="agent-trace-wall-clock-table"><thead><tr><th>${biHtml(AT.meta.invocationKindZh, AT.meta.invocationKindEn)}</th><th>${biHtml(AT.meta.vendorRoundtripLatencyZh, AT.meta.vendorRoundtripLatencyEn)}</th></tr></thead><tbody>${rows}</tbody></table></div>`
}

/** @param {HTMLElement} card @param {Record<string, unknown>} ev */
function renderTimelineCardBody(card, ev) {
  const kind = ev.kind
  const data = ev.data

  if (kind === 'user' && data && typeof data === 'object') {
    const ui = data.user_input != null ? String(data.user_input) : ''
    if (ui.trim()) {
      const pre = document.createElement('pre')
      pre.className = 'agent-trace-user-input agent-trace-tl-user-pre'
      pre.textContent = ui
      card.appendChild(pre)
    } else {
      const p = document.createElement('p')
      p.className = 'form-hint'
      p.textContent = biText(AT.noUserTextZh, AT.noUserTextEn)
      card.appendChild(p)
    }
    const sc = data.activated_scenarios
    if (sc != null && (Array.isArray(sc) ? sc.length : true)) {
      let display
      try {
        display = Array.isArray(sc)
          ? sc.map((x) => String(x)).filter(Boolean).join(LIST_SEP)
          : typeof sc === 'string'
            ? sc
            : JSON.stringify(sc)
      } catch {
        display = String(sc)
      }
      const row = document.createElement('div')
      row.className = 'agent-trace-activated-inline'
      row.lang = 'zh-CN'
      row.innerHTML = `<span class="agent-trace-activated-inline-k">${biHtml(AT.detailKeys.activatedScenariosZh, AT.detailKeys.activatedScenariosEn)}</span><code class="agent-trace-activated-inline-v mono">${escHtml(display || EM_DASH)}</code>`
      card.appendChild(row)
    }
    if (data.snap && typeof data.snap === 'object') {
      appendDetailJson(card, AT.detailKeys.turnSnapshotZh, AT.detailKeys.turnSnapshotEn, data.snap, 12000)
    }
    return
  }

  if (kind === 'model_http' && data && typeof data === 'object') {
    const rec = /** @type {Record<string, unknown>} */ (data)
    const hint = document.createElement('p')
    hint.className = 'form-hint agent-trace-i18n-block'
    hint.style.margin = '0 0 8px'
    hint.innerHTML =
      rec.vendor_response != null
        ? biHtml(AT.modelHttpVendorNoteWithResponseZh, AT.modelHttpVendorNoteWithResponseEn)
        : biHtml(AT.modelHttpVendorNoteZh, AT.modelHttpVendorNoteEn)
    card.appendChild(hint)
    if (rec.vendor_request_full != null && typeof rec.vendor_request_full === 'object')
      appendDetailJson(card, AT.detailKeys.vendorRequestFullZh, AT.detailKeys.vendorRequestFullEn, rec.vendor_request_full, null)
    if (rec.payload != null && typeof rec.payload === 'object') {
      const meta = { ...rec }
      delete meta.payload
      delete meta.vendor_request_full
      delete meta.vendor_response
      delete meta.vendor_latency_ms
      if (Object.keys(meta).length) appendDetailJson(card, AT.detailKeys.modelRecordMetaZh, AT.detailKeys.modelRecordMetaEn, meta, null)
      appendDetailJson(card, AT.detailKeys.fullPayloadZh, AT.detailKeys.fullPayloadEn, rec.payload, null)
    } else {
      const slim = { ...rec }
      delete slim.vendor_request_full
      delete slim.vendor_response
      delete slim.vendor_latency_ms
      appendDetailJson(card, AT.detailKeys.fullPayloadZh, AT.detailKeys.fullPayloadEn, slim, null)
    }
    if (rec.vendor_response != null)
      appendDetailJson(card, AT.detailKeys.vendorResponseZh, AT.detailKeys.vendorResponseEn, rec.vendor_response, null)
    return
  }

  if (kind === 'tool' && data && typeof data === 'object') {
    const rec = data
    /* ??/??? keyfacts ??????????????? JSON */
    appendDetailJson(card, AT.detailKeys.toolRowZh, AT.detailKeys.toolRowEn, rec, null)
    return
  }

  if (data != null && typeof data === 'object') {
    appendDetailJson(card, AT.detailKeys.rawJsonZh, AT.detailKeys.rawJsonEn, data, 32000)
  }
}

/** ??????????????????????????????????? */
function renderTurnTimeline(container, payload, turnIndex) {
  container.innerHTML = ''
  const ct = payload && typeof payload === 'object' ? payload.conversation_turns || {} : {}
  const turns = asArray(ct.turns)
  if (!turns.length) {
    container.innerHTML = `<p class="form-hint agent-trace-i18n-block" style="margin:0">${biHtml(AT.noTurnAggregateZh, AT.noTurnAggregateEn)}</p>`
    return
  }

  const idx = Math.min(Math.max(0, turnIndex), turns.length - 1)
  const turn = turns[idx]
  if (!turn) {
    container.innerHTML = `<p class="form-hint agent-trace-i18n-block" style="margin:0">${biHtml(AT.noSuchTurnZh, AT.noSuchTurnEn)}</p>`
    return
  }

  const timing = getTurnTiming(turn, payload, idx)
  const events = buildTurnTimelineEvents(turn, payload, timing)

  const wrap = document.createElement('div')
  wrap.className = 'agent-trace-detail-body'

  const timingEl = document.createElement('div')
  timingEl.className = 'agent-trace-timing-banner'
  timingEl.innerHTML = renderTurnTimingPanelHtml(timing)
  wrap.appendChild(timingEl)

  if (!events.length) {
    const p = document.createElement('p')
    p.className = 'form-hint agent-trace-i18n-block'
    p.innerHTML = biHtml(AT.timelineEmptyZh, AT.timelineEmptyEn)
    wrap.appendChild(p)
    container.appendChild(wrap)
    return
  }

  const segments = mergeLeadingPreModelCycleSegments(splitEventsByModelCycleSegments(events))
  /** ??????????????????????? */
  const phaseCarry = /** @type {{ current: string | null; lastRailPhaseKey: string | null }} */ ({
    current: null,
    lastRailPhaseKey: null,
  })

  segments.forEach((seg, segIdx) => {
    const block = document.createElement('div')
    block.className = 'agent-trace-model-cycle-block'

    const fold = document.createElement('details')
    fold.className = 'agent-trace-model-cycle-fold'
    fold.open = true

    const sum = document.createElement('summary')
    sum.className = 'agent-trace-model-cycle-fold-sum'
    const sumMain = document.createElement('div')
    sumMain.className = 'agent-trace-model-cycle-fold-sum-main'

    const titleCol = document.createElement('div')
    titleCol.className = 'agent-trace-model-cycle-fold-title-col'

    const titleRow = document.createElement('div')
    titleRow.className = 'agent-trace-model-cycle-fold-title-row'

    const titleSpan = document.createElement('span')
    titleSpan.className = 'agent-trace-model-cycle-fold-title'
    titleSpan.lang = 'zh-CN'
    if (seg.cycleNum != null && seg.cycleNum >= 1) {
      titleSpan.textContent = biText(AT.modelCycleFoldNthZh(seg.cycleNum), AT.modelCycleFoldNthEn(seg.cycleNum))
    } else {
      titleSpan.textContent = biText(AT.modelCycleFoldTimelineOnlyZh, AT.modelCycleFoldTimelineOnlyEn)
    }
    titleRow.appendChild(titleSpan)

    const titleRowRight = document.createElement('div')
    titleRowRight.className = 'agent-trace-model-cycle-fold-title-right'
    const nEv = seg.items.length
    appendModelCycleFoldTokenAndNodesRight(
      titleRowRight,
      payload,
      /** @type {{ cycleNum: number | null }} */ (seg),
      nEv,
    )
    titleRow.appendChild(titleRowRight)
    titleCol.appendChild(titleRow)

    appendModelCycleFoldScenarioToolsRow(
      titleCol,
      turn,
      /** @type {{ cycleNum: number | null }} */ (seg),
    )

    const prevSeg = segIdx > 0 ? segments[segIdx - 1] : null
    const causeLine = buildModelCycleFoldCauseLine(
      turn,
      /** @type {{ cycleNum: number | null; items: unknown[]; timelineOnly?: boolean }} */ (seg),
      prevSeg ? /** @type {{ cycleNum: number | null; items: unknown[]; timelineOnly?: boolean }} */ (prevSeg) : null,
    )
    if (causeLine) {
      const causeSpan = document.createElement('span')
      causeSpan.className = 'agent-trace-model-cycle-fold-cause'
      causeSpan.lang = 'zh-CN'
      causeSpan.textContent = causeLine
      titleCol.appendChild(causeSpan)
    }

    sumMain.appendChild(titleCol)
    sum.appendChild(sumMain)

    const inner = document.createElement('div')
    inner.className = 'agent-trace-model-cycle-fold-inner'

    const tl = document.createElement('div')
    tl.className = 'agent-trace-tl'
    /** ??????????????????????? phaseCarry.current */
    phaseCarry.lastRailPhaseKey = null
    const hideBanner = seg.cycleNum != null && seg.cycleNum >= 1
    seg.items.forEach((ev) => appendTimelineEventRow(tl, ev, phaseCarry, { hideCycleBanner: hideBanner }))

    inner.appendChild(tl)
    fold.appendChild(sum)
    fold.appendChild(inner)
    block.appendChild(fold)
    wrap.appendChild(block)
  })

  container.appendChild(wrap)
}

/**
 * ???????????????????
 * @param {(tid: string, idx: number) => void} onPickTurn ?? replaceState??????????
 */
function renderTurnSidebar(pageEl, payload, selectedIdx = 0, onPickTurn = () => {}) {
  const listEl = pageEl.querySelector('#at-turn-list')
  const tid = getRouteThreadId()

  if (!listEl) return

  if (!tid) {
    listEl.innerHTML = `<p class="form-hint agent-trace-turn-empty">${biHtml(AT.pickSessionZh, AT.pickSessionEn)}</p>`
    return
  }

  if (payload == null) {
    listEl.innerHTML = `<p class="form-hint agent-trace-turn-empty">${biHtml(AT.loadFailedZh, AT.loadFailedEn)}</p>`
    return
  }

  const ct = typeof payload === 'object' ? payload.conversation_turns || {} : {}
  const turns = asArray(ct.turns)

  if (!turns.length) {
    listEl.innerHTML = `<p class="form-hint agent-trace-turn-empty">${biHtml(AT.noTurnDataZh, AT.noTurnDataEn)}<br/><span class="agent-trace-muted-sub">${biHtml(AT.needRoundLogZh, AT.needRoundLogEn)}</span></p>`
    return
  }

  listEl.innerHTML = ''

  turns.forEach((turn, idx) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.dataset.turnIndex = String(idx)
    b.className =
      'agent-trace-turn-btn' + (selectedIdx === idx ? ' agent-trace-turn-btn--active' : '')
    const label = turn.label || biText(AT.turnLabelNthZh(idx + 1), AT.turnLabelNthEn(idx + 1))
    const t = turn.timing && typeof turn.timing === 'object' ? turn.timing : null
    const durMs =
      t?.page_round_trip_ms ?? t?.langgraph_run_wall_ms ?? turnWallDurationMs(turn)
    const durHtml =
      durMs != null && Number.isFinite(Number(durMs))
        ? `<span class="agent-trace-turn-btn-dur mono">${escHtml(formatDurationSec(durMs))}</span>`
        : ''
    b.innerHTML = `<span class="agent-trace-turn-btn-label">${escHtml(label)}</span>${durHtml}`
    b.addEventListener('click', () => onPickTurn(tid, idx))
    listEl.appendChild(b)
  })
}

/** @param {HTMLElement} wrap @param {unknown} arr */
function renderJsonTable(wrap, arr) {
  const rows = asArray(arr)
  wrap.innerHTML = ''
  if (!rows.length) {
    wrap.innerHTML = `<p class="form-hint">${biHtml(AT.noDataZh, AT.noDataEn)}</p>`
    return
  }
  const table = document.createElement('table')
  table.className = 'agent-trace-simple-table'
  const thead = document.createElement('thead')
  const hr = document.createElement('tr')
  hr.innerHTML = `<th class="idx">#</th><th>${biHtml(AT.jsonTableColZh, AT.jsonTableColEn)}</th>`
  thead.appendChild(hr)
  table.appendChild(thead)
  const tbody = document.createElement('tbody')

  rows.forEach((row, i) => {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td class="idx">${i + 1}</td>`
    const td = document.createElement('td')
    const oneLine = (() => {
      try {
        return trunc(JSON.stringify(row).replace(/\s+/g, ' '), 140)
      } catch {
        return '…'
      }
    })()
    const sid = stashJsonForModal(row)
    td.innerHTML = `<div class="agent-trace-json-table-cell"><span class="agent-trace-json-table-preview mono" lang="zh-CN">${escHtml(oneLine)}</span></div>`
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'agent-trace-json-modal-open'
    btn.setAttribute('data-json-ref', sid)
    btn.setAttribute('data-json-title', `${biText(AT.jsonTableColZh, AT.jsonTableColEn)} #${i + 1}`)
    btn.textContent = biText(AT.jsonModalOpenZh, AT.jsonModalOpenEn)
    td.querySelector('.agent-trace-json-table-cell')?.appendChild(btn)
    tr.appendChild(td)
    tbody.appendChild(tr)
  })

  table.appendChild(tbody)
  wrap.appendChild(table)
}

/** @param {HTMLElement} wrap @param {unknown} obj */
function renderJsonPretty(wrap, obj) {
  wrap.innerHTML = ''
  if (obj == null || (typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === 0)) {
    wrap.innerHTML = `<p class="form-hint">${biHtml(AT.noDataZh, AT.noDataEn)}</p>`
    return
  }
  const bar = document.createElement('div')
  bar.className = 'agent-trace-json-pretty-bar'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'agent-trace-json-modal-open'
  btn.setAttribute('data-json-ref', stashJsonForModal(obj))
  btn.setAttribute('data-json-title', biText(AT.detailKeys.rawJsonZh, AT.detailKeys.rawJsonEn))
  btn.textContent = biText(AT.jsonModalOpenZh, AT.jsonModalOpenEn)
  bar.appendChild(btn)
  wrap.appendChild(bar)
}

/** @param {HTMLElement} wrap @param {unknown} csd */
function renderClaudeSessionsDebug(wrap, csd) {
  wrap.innerHTML = ''
  const root = csd && typeof csd === 'object' ? /** @type {Record<string, unknown>} */ (csd) : {}
  const note = root.note_zh != null ? String(root.note_zh) : ''
  const logsDir = root.logs_dir != null ? String(root.logs_dir) : ''
  const sessions = asArray(root.sessions)
  if (note) {
    const p = document.createElement('p')
    p.className = 'form-hint agent-trace-i18n-block'
    p.lang = 'zh-CN'
    p.textContent = note
    wrap.appendChild(p)
  }
  if (logsDir) {
    const p2 = document.createElement('p')
    p2.className = 'form-hint mono'
    p2.style.fontSize = '12px'
    p2.style.marginTop = '0'
    p2.textContent = logsDir
    wrap.appendChild(p2)
  }
  if (!sessions.length) {
    const p3 = document.createElement('p')
    p3.className = 'form-hint'
    p3.innerHTML = biHtml(AT.claudeSessionsEmptyZh, AT.claudeSessionsEmptyEn)
    wrap.appendChild(p3)
    return
  }
  sessions.forEach((raw) => {
    if (!raw || typeof raw !== 'object') return
    const s = /** @type {Record<string, unknown>} */ (raw)
    const det = document.createElement('details')
    det.className = 'agent-trace-claude-session-fold'
    if (sessions.length <= 4) det.open = true
    const sm = document.createElement('summary')
    sm.className = 'agent-trace-claude-session-sum'
    const sid = String(s.session_id || '')
    const found = Boolean(s.found)
    const srcArr = asArray(s.sources)
    const src = srcArr.map(String).filter(Boolean).join('?')
    const nEv = asArray(s.events).length
    const title = document.createElement('span')
    title.className = 'agent-trace-claude-session-title'
    const strong = document.createElement('strong')
    strong.textContent = sid
    title.appendChild(strong)
    const meta = document.createElement('span')
    meta.className = 'agent-trace-claude-session-meta'
    if (found) {
      meta.textContent = ` ${MID_DOT} ${biText(AT.obsUi.eventsCountZh(nEv), '')}` + (s.events_truncated ? biText(AT.obsUi.truncatedZh, '') : '') + (src ? ` ${MID_DOT} ${src}` : '')
    } else {
      meta.textContent =
        ` ? ${biText(AT.claudeSessionsMissingFileZh, AT.claudeSessionsMissingFileEn)}` + (src ? ` ? ${src}` : '')
    }
    sm.appendChild(title)
    sm.appendChild(meta)
    det.appendChild(sm)
    const inner = document.createElement('div')
    inner.className = 'agent-trace-claude-session-body'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'agent-trace-json-modal-open'
    btn.setAttribute('data-json-ref', stashJsonForModal(s))
    btn.setAttribute('data-json-title', sid || 'session')
    btn.textContent = biText(AT.jsonModalOpenZh, AT.jsonModalOpenEn)
    inner.appendChild(btn)
    det.appendChild(inner)
    wrap.appendChild(det)
  })
}

/** @param {HTMLElement} wrap @param {unknown} arr */
function renderLifecycleTable(wrap, arr) {
  const rows = asArray(arr)
  wrap.innerHTML = ''
  if (!rows.length) {
    wrap.innerHTML = `<p class="form-hint">${biHtml(AT.lifecycleEmptyZh, AT.lifecycleEmptyEn)}</p>`
    return
  }
  const table = document.createElement('table')
  table.className = 'agent-trace-simple-table'
  const thead = document.createElement('thead')
  const hr = document.createElement('tr')
  hr.innerHTML = `<th class="idx">#</th><th>${biHtml(AT.kf.timeZh, 'Time')}</th><th>${biHtml(AT.kf.eventZh, 'Event')}</th><th>${biHtml(AT.kf.mainTaskZh, 'Main task')}</th><th>${biHtml(AT.kf.subtaskZh, 'Subtask')}</th><th>${biHtml(AT.kf.statusZh, 'Status')}</th><th>${biHtml(AT.detailKeys.rawJsonZh, 'Detail')}</th>`
  thead.appendChild(hr)
  table.appendChild(thead)
  const tbody = document.createElement('tbody')

  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object') return
    const tr = document.createElement('tr')
    const ts = row.ts != null ? row.ts : row.timestamp
    tr.innerHTML = `
      <td class="idx">${i + 1}</td>
      <td>${escHtml(formatIso(ts))}</td>
      <td>${escHtml(trunc(String(row.event ?? ''), 36))}</td>
      <td class="mono">${escHtml(trunc(String(row.main_task_id ?? ''), 20))}</td>
      <td class="mono">${escHtml(trunc(String(row.subtask_id ?? ''), 20))}</td>
      <td>${escHtml(String(row.status ?? '?'))}</td>`
    const tdDet = document.createElement('td')
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'agent-trace-json-modal-open'
    btn.setAttribute('data-json-ref', stashJsonForModal(row))
    btn.setAttribute(
      'data-json-title',
      `${biText(AT.detailKeys.rawJsonZh, AT.detailKeys.rawJsonEn)} #${i + 1}`,
    )
    btn.textContent = biText(AT.jsonModalOpenZh, AT.jsonModalOpenEn)
    tdDet.appendChild(btn)
    tr.appendChild(tdDet)
    tbody.appendChild(tr)
  })

  table.appendChild(tbody)
  wrap.appendChild(table)
}

export function cleanup() {
  if (_pollTimer) {
    clearInterval(_pollTimer)
    _pollTimer = null
  }
  if (_detachAgentTraceHashSync) {
    try {
      _detachAgentTraceHashSync()
    } catch {
      /* ignore */
    }
    _detachAgentTraceHashSync = null
  }
  document.getElementById('content')?.classList.remove('agent-trace-host')
  document.getElementById('agent-trace-root')?.classList.remove('agent-trace-host')
}

export async function render() {
  cleanup()
  document.getElementById('content')?.classList.add('agent-trace-host')
  document.getElementById('agent-trace-root')?.classList.add('agent-trace-host')
  installAgentTraceJsonModalDelegate()
  installAgentTraceSystemPromptDelegate()

  const page = document.createElement('div')
  page.className = 'page agent-trace-page obs-console-host'

  page.innerHTML = `
    <div class="page-header obs-console-page-header">
      <div>
        <h1 class="page-title">${biHtml(AT.pageTitleZh, AT.pageTitleEn)}</h1>
        <p class="page-desc" id="at-page-desc">${biHtml('观测数据与会话调试', 'Observability and session debug')}</p>
      </div>
      <div class="page-actions">
        <a class="btn btn-ghost btn-sm" href="#/operations">${biText('\u8fd0\u7ef4\u89c2\u6d4b', 'Operations')}</a>
        <button type="button" class="btn btn-secondary btn-sm" id="at-obs-refresh">${biText('\u5237\u65b0', 'Refresh')}</button>
      </div>
    </div>

    <div id="at-banner" class="agent-trace-banner agent-trace-banner--err" hidden></div>

    <div class="tasks-time-filter-bar obs-console-time-bar" id="at-obs-time-filter-bar"></div>

    <div class="page-content at-page-content obs-console-shell">
      <div class="el-obs-layout obs-console">
        <aside class="el-obs-aside">
          <div class="el-obs-rail-brand">
            <div class="el-obs-rail-title">Agent Trace</div>
            <div class="el-obs-rail-caption">${biText('观测与调试', 'Observability')}</div>
          </div>
          <nav class="el-obs-menu" id="at-side-nav" role="navigation">${renderObsSideNav(AT_MENU_GROUPS, 'overview')}</nav>
        </aside>
        <div class="el-obs-main">
          <div id="at-module-topbar">${renderObsTopbar({ title: AT_MENU_GROUPS[0].label, subtitle: `${AT_MENU_GROUPS[0].hint} · ${getObsTimeRangeLabel()}` })}</div>
          <div class="el-obs-column">
            <div class="el-obs-panel" id="at-overview-panel">
              <div id="at-stats-grid"></div>
              <div id="at-recent-activity-list"></div>
            </div>
            <div class="el-obs-panel" id="at-tools-panel" hidden>
              <div id="at-tools-filter-wrap" class="obs-filter-mount"></div>
              <div id="at-tools-stats"></div>
              <div class="task-obs-panel obs-table-panel">
                <div class="task-obs-panel-header">
                  <h3 class="task-obs-panel-title">${biText('\u8c03\u7528\u8be6\u60c5', 'Details')}</h3>
                </div>
                <div class="task-obs-panel-body">
                  <div class="task-obs-table-wrap">
                    <table class="task-obs-table obs-data-table" id="at-tools-table">
                      <thead><tr><th>#</th><th>${biText('\u65f6\u95f4', 'Time')}</th><th>${biText('\u5de5\u5177\u540d', 'Tool')}</th><th>${biText('\u72b6\u6001', 'Status')}</th><th>${biText('\u8017\u65f6', 'Duration')}</th><th>${biText('\u4f1a\u8bdd', 'Thread')}</th><th>${biText('\u62a5\u9519', 'Error')}</th><th>${biText('\u64cd\u4f5c', 'Actions')}</th></tr></thead>
                      <tbody id="at-tools-table-body"></tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div id="at-tools-pagination"></div>
            </div>
            <div class="el-obs-panel" id="at-models-panel" hidden>
              <div id="at-models-filter-wrap" class="obs-filter-mount"></div>
              <div id="at-models-stats"></div>
              <div class="task-obs-panel obs-table-panel">
                <div class="task-obs-panel-header">
                  <h3 class="task-obs-panel-title">${biText('\u6a21\u578b\u8bf7\u6c42\u660e\u7ec6', 'Model requests')}</h3>
                </div>
                <div class="task-obs-panel-body">
                  <div class="task-obs-table-wrap">
                    <table class="task-obs-table obs-data-table" id="at-models-table">
                      <thead><tr><th>#</th><th>${biText('\u65f6\u95f4', 'Time')}</th><th>${biText('\u7528\u9014', 'Kind')}</th><th>${biText('\u6a21\u578b', 'Model')}</th><th>${biText('\u8017\u65f6', 'Duration')}</th><th>${biText('\u8f93\u5165 Token', 'In tokens')}</th><th>${biText('\u7f13\u5b58\u547d\u4e2d', 'Cache hit')}</th><th>${biText('\u8f93\u51fa Token', 'Out tokens')}</th><th>Thread</th><th>${biText('\u7cfb\u7edf\u63d0\u793a\u8bcd', 'System prompt')}</th><th>${biText('\u8bf7\u6c42', 'Request')}</th><th>${biText('\u8fd4\u56de\u7c7b\u578b', 'Response type')}</th><th>${biText('\u8fd4\u56de\u5185\u5bb9', 'Response')}</th><th>${biText('\u54cd\u5e94', 'Response')}</th></tr></thead>
                      <tbody id="at-models-table-body"></tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div id="at-models-pagination"></div>
            </div>
            <div class="el-obs-panel" id="at-gateway-panel" hidden>
              <div id="at-gateway-filter-wrap" class="obs-filter-mount"></div>
              <div id="at-gateway-stats"></div>
              <div class="task-obs-panel obs-table-panel">
                <div class="task-obs-panel-header">
                  <h3 class="task-obs-panel-title">Gateway ${biText('\u8bf7\u6c42\u660e\u7ec6', 'requests')}</h3>
                </div>
                <div class="task-obs-panel-body">
                  <div class="task-obs-table-wrap">
                    <table class="task-obs-table obs-data-table" id="at-gateway-table">
                      <thead><tr><th>#</th><th>${biText('\u65f6\u95f4', 'Time')}</th><th>Method</th><th>Path</th><th>Status</th><th>${biText('\u8017\u65f6', 'Duration')}</th><th>IP</th><th>Content-Type</th><th>${biText('\u64cd\u4f5c', 'Actions')}</th></tr></thead>
                      <tbody id="at-gateway-table-body"></tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div id="at-gateway-pagination"></div>
            </div>
            <div class="el-obs-panel el-obs-panel--sessions" id="at-sessions-panel" hidden>
              <div class="im-split-layout agent-trace-split el-obs-sessions-split">
                <aside class="im-sidebar agent-trace-sidebar agent-trace-sidebar--threads">
                  <div class="agent-trace-sidebar-search">
                    <input type="search" id="at-filter" placeholder="${escHtml(AT.filterPlaceholderZh)}" autocomplete="off" />
                  </div>
                  <p id="at-thread-source-hint" class="el-obs-thread-source-hint" hidden></p>
                  <div class="im-channel-list agent-trace-thread-list" id="at-thread-list"></div>
                  <div class="agent-trace-sidebar-foot">
                    <label class="switch-row el-obs-live-switch agent-trace-sidebar-live">
                      <input type="checkbox" id="at-live" />
                      <span class="switch-slider"></span>
                      <span class="switch-label switch-label--i18n">${biHtml(AT.liveRefreshZh, AT.liveRefreshEn)}</span>
                    </label>
                    <input type="text" id="at-tid-manual" placeholder="${escHtml(AT.manualTidPlaceholderZh)}" />
                    <button type="button" class="btn btn-primary btn-sm agent-trace-btn-i18n" id="at-open-manual">${biHtml(AT.openZh, AT.openEn)}</button>
                  </div>
                </aside>
                <aside class="im-sidebar agent-trace-sidebar agent-trace-sidebar--turns" id="at-turn-sidebar" aria-label="${escHtml(AT.turnColumnZh)}">
                  <div class="agent-trace-turn-column-head">${biHtml(AT.turnColumnZh, AT.turnColumnEn)}</div>
                  <div class="agent-trace-turn-list-scroll" id="at-turn-list"></div>
                </aside>
                <div class="agent-trace-main">
                  <div class="agent-trace-toolbar">
                    <div class="agent-trace-toolbar-meta" id="at-status">${biHtml(AT.toolbarPickZh, AT.toolbarPickEn)}</div>
                  </div>
                  <div class="agent-trace-scroll">
                    <details class="agent-trace-turn-overview agent-trace-turn-overview--main" id="at-turn-overview">
                      <summary class="agent-trace-turn-overview-sum" lang="zh-CN">${escHtml(AT.turnOverviewSummaryZh)}</summary>
                      <div id="at-summary" class="agent-trace-turn-overview-body"></div>
                    </details>
                    <section class="agent-trace-detail-panel">
                      <div id="at-timeline"></div>
                    </section>
                    <details class="config-section agent-trace-raw-section">
                      <summary class="config-section-title agent-trace-raw-summary" style="cursor:pointer;user-select:none">${biHtml(AT.rawSectionZh, AT.rawSectionEn)}</summary>
                      <div class="agent-trace-raw-wrap">
                        <div class="agent-trace-tabs" id="at-tabs"></div>
                        <div id="at-raw-panel"></div>
                      </div>
                    </details>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `

  const tabIds = ['collab', 'payload', 'round', 'tools', 'lifecycle', 'tps', 'tokens', 'claude', 'lg']

  const tabsEl = page.querySelector('#at-tabs')
  tabIds.forEach((id, i) => {
    const pair = AT.tabs[id]
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'agent-trace-tab' + (i === 0 ? ' agent-trace-tab--active' : '')
    b.dataset.tab = id
    b.innerHTML = pair ? biHtml(pair[0], pair[1]) : escHtml(id)
    tabsEl.appendChild(b)
  })

  let currentPayload = null
  let activeTab = 'collab'

  let activeMenu = 'overview'
  let threadTitleMap = new Map()
  let lastThreadList = []
  /** @type {((threads: unknown[]) => void) | null} */
  let renderThreadButtonsRef = null

  function ensureSessionTitlesBackground() {
    void loadSessionTitleMap(api).then((m) => {
      if (!m?.size) return
      threadTitleMap = m
      if (renderThreadButtonsRef && lastThreadList.length) {
        renderThreadButtonsRef(lastThreadList)
      }
      const tid = getRouteThreadId()
      if (!tid || !currentPayload) return
      const el = page.querySelector('#at-status .at-session-head-title')
      if (el) el.textContent = sessionDisplayTitle(tid, threadTitleMap)
    })
  }

  function updateModuleTopbar(menuId) {
    const sec = AT_MENU_GROUPS.find((g) => g.key === menuId)
    const mount = page.querySelector('#at-module-topbar')
    if (!mount || !sec) return
    mount.innerHTML = renderObsTopbar({
      title: sec.label,
      subtitle: `${sec.hint || ''} · ${getObsTimeRangeLabel()}`,
    })
  }

  function onPickThreadFromObs(tid) {
    switchMenu('sessions')
    navigateAgentTrace(tid)
  }

  function switchMenu(menuId) {
    activeMenu = menuId
    page.querySelectorAll('.el-obs-panel').forEach((panel) => {
      const show = panel.id === `at-${menuId}-panel`
      if (show) panel.removeAttribute('hidden')
      else panel.setAttribute('hidden', '')
    })
    page.querySelectorAll('#at-side-nav [data-obs-nav]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-obs-nav') === menuId)
    })
    updateModuleTopbar(menuId)
    switchMenuPanel(menuId)
  }

  function switchMenuPanel(menuId) {
    page.querySelectorAll('.el-obs-panel').forEach((panel) => {
      const show = panel.id === `at-${menuId}-panel`
      if (show) panel.removeAttribute('hidden')
      else panel.setAttribute('hidden', '')
    })
    if (menuId === 'sessions') {
      void loadThreadList()
      void loadData()
    } else if (menuId === 'overview') {
      page.querySelector('#at-stats-grid').innerHTML = `<p class="el-obs-hint">${biText(AT.obsUi.loadingZh, 'Loading')}</p>`
      page.querySelector('#at-recent-activity-list').innerHTML = ''
      void renderOverviewPage()
    } else if (menuId === 'tools') {
      page.querySelector('#at-tools-stats').innerHTML = `<p class="el-obs-hint">${biText(AT.obsUi.loadingZh, 'Loading')}</p>`
      page.querySelector('#at-tools-table-body').innerHTML = `<tr><td colspan="8" class="el-obs-empty">${biText(AT.obsUi.loadingZh, 'Loading')}</td></tr>`
      void renderToolsPage()
    } else if (menuId === 'models') {
      page.querySelector('#at-models-stats').innerHTML = `<p class="el-obs-hint">${biText(AT.obsUi.loadingZh, 'Loading')}</p>`
      page.querySelector('#at-models-table-body').innerHTML = `<tr><td colspan="14" class="el-obs-empty">${biText(AT.obsUi.loadingZh, 'Loading')}</td></tr>`
      void renderModelsPage()
    } else if (menuId === 'gateway') {
      page.querySelector('#at-gateway-stats').innerHTML = `<p class="el-obs-hint">${biText(AT.obsUi.loadingZh, 'Loading')}</p>`
      page.querySelector('#at-gateway-table-body').innerHTML = `<tr><td colspan="9" class="el-obs-empty">${biText(AT.obsUi.loadingZh, 'Loading')}</td></tr>`
      void renderGatewayPage()
    }
  }

  function refreshActiveObsPanel() {
    switchMenuPanel(activeMenu)
  }

  bindObsSideNav(page.querySelector('#at-side-nav'), switchMenu)
  renderObsTimeFilterBar(page.querySelector('#at-obs-time-filter-bar'), () => {
    updateModuleTopbar(activeMenu)
    refreshActiveObsPanel()
  })
  page.querySelector('#at-obs-refresh')?.addEventListener('click', () => {
    refreshActiveObsPanel()
  })

  async function renderOverviewPage() {
    const pick = (tid) => onPickThreadFromObs(tid)
    if (await isObservabilityEnabled()) {
      try {
        await renderOverviewFromSqlite(page, { onPickThread: pick })
        return
      } catch (e) {
        page.querySelector('#at-stats-grid').innerHTML = `<p class="el-obs-hint" style="color:var(--el-color-warning)">${biText(AT.obsUi.overviewLoadFailZh, '')} ${escHtml(String(e.message || e))}</p>`
        page.querySelector('#at-recent-activity-list').innerHTML = ''
        return
      }
    }
    page.querySelector('#at-stats-grid').innerHTML = `<p class="el-obs-hint">${biText(AT.obsUi.obsConfigHintZh, '')}</p>`
    page.querySelector('#at-recent-activity-list').innerHTML = ''
  }

  async function renderToolsPage() {
    const pick = (tid) => onPickThreadFromObs(tid)
    if (await isObservabilityEnabled()) {
      try {
        await renderToolsFromSqlite(page, { onPickThread: pick })
        return
      } catch (e) {
        page.querySelector('#at-tools-stats').innerHTML = `<p class="el-obs-hint" style="color:var(--el-color-warning)">${biText(AT.obsUi.toolsLoadFailZh, '')} ${escHtml(String(e.message || e))}</p>`
      }
    } else {
      page.querySelector('#at-tools-stats').innerHTML = `<p class="el-obs-hint">${biText(AT.obsUi.needObsZh, '')}</p>`
      page.querySelector('#at-tools-table-body').innerHTML = `<tr><td colspan="8" class="el-obs-empty">${biText(AT.obsUi.noDataZh, '')}</td></tr>`
    }
  }

  async function renderModelsPage() {
    const pick = (tid) => onPickThreadFromObs(tid)
    if (await isObservabilityEnabled()) {
      try {
        await renderModelsFromSqlite(page, { onPickThread: pick })
        return
      } catch (e) {
        page.querySelector('#at-models-stats').innerHTML = `<p class="el-obs-hint" style="color:var(--el-color-warning)">${biText(AT.obsUi.modelsLoadFailZh, '')} ${escHtml(String(e.message || e))}</p>`
      }
    } else {
      page.querySelector('#at-models-stats').innerHTML = `<p class="el-obs-hint">${biText(AT.obsUi.needObsZh, '')}</p>`
      page.querySelector('#at-models-table-body').innerHTML = `<tr><td colspan="14" class="el-obs-empty">${biText(AT.obsUi.noDataZh, '')}</td></tr>`
    }
  }

  async function renderGatewayPage() {
    if (await isObservabilityEnabled()) {
      try {
        await renderGatewayRequestsFromSqlite(page)
        return
      } catch (e) {
        page.querySelector('#at-gateway-stats').innerHTML = `<p class="el-obs-hint" style="color:var(--el-color-warning)">Gateway 请求加载失败 ${escHtml(String(e.message || e))}</p>`
      }
    } else {
      page.querySelector('#at-gateway-stats').innerHTML = `<p class="el-obs-hint">${biText(AT.obsUi.needObsZh, '')}</p>`
      page.querySelector('#at-gateway-table-body').innerHTML = `<tr><td colspan="9" class="el-obs-empty">${biText(AT.obsUi.noDataZh, '')}</td></tr>`
    }
  }


  function applyTurnLocal(tid, turnIdx) {
    if (!currentPayload || String(currentPayload.thread_id || '') !== String(tid)) return
    const ct = currentPayload.conversation_turns || {}
    const turns = asArray(ct.turns)
    if (!turns.length) return
    const idx = Math.min(Math.max(0, turnIdx), turns.length - 1)
    normalizeAgentTraceHash(tid, idx)
    renderTurnSummary(page.querySelector('#at-summary'), currentPayload, idx)
    renderTurnTimeline(page.querySelector('#at-timeline'), currentPayload, idx)
    page.querySelectorAll('#at-turn-list .agent-trace-turn-btn').forEach((btn) => {
      const t = parseInt(btn.dataset.turnIndex, 10)
      btn.classList.toggle('agent-trace-turn-btn--active', !Number.isNaN(t) && t === idx)
    })
  }

  function onPickTurn(tid, idx) {
    applyTurnLocal(tid, idx)
  }

  function showRawPanel() {
    const wrap = page.querySelector('#at-raw-panel')
    if (!currentPayload) {
      wrap.innerHTML = `<p class="form-hint">${biHtml(AT.rawAfterLoadZh, AT.rawAfterLoadEn)}</p>`
      return
    }
    if (activeTab === 'lifecycle') {
      renderLifecycleTable(wrap, currentPayload.task_lifecycle_trace)
      return
    }
    if (activeTab === 'tps') {
      renderJsonPretty(wrap, currentPayload.task_progress_snapshot)
      return
    }
    if (activeTab === 'tokens') {
      renderJsonPretty(wrap, currentPayload.token_usage_debug)
      return
    }
    if (activeTab === 'claude') {
      renderClaudeSessionsDebug(wrap, currentPayload.claude_sessions_debug)
      return
    }
    const map = {
      collab: currentPayload.collab_cycle,
      payload: currentPayload.model_request_payloads,
      round: currentPayload.lead_agent_round,
      tools: currentPayload.tool_call_io,
      lg: currentPayload.langgraph && currentPayload.langgraph.runs,
    }
    renderJsonTable(wrap, map[activeTab])
  }

  tabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.agent-trace-tab')
    if (!btn || !btn.dataset.tab) return
    activeTab = btn.dataset.tab
    tabsEl.querySelectorAll('.agent-trace-tab').forEach((x) => {
      x.classList.toggle('agent-trace-tab--active', x.dataset.tab === activeTab)
    })
    showRawPanel()
  })

  async function loadThreadList() {
    const box = page.querySelector('#at-thread-list')
    const hintEl = page.querySelector('#at-thread-source-hint')
    const q = (page.querySelector('#at-filter').value || '').trim().toLowerCase()
    const cur = getRouteThreadId()
    ensureSessionTitlesBackground()

    const applyHint = (mode) => {
      if (!hintEl) return
      const zh =
        mode === 'sqlite'
          ? AT.threadListSourceSqliteZh
          : mode === 'fallback'
            ? AT.threadListSourceObsFallbackZh
            : AT.threadListSourceLogZh
      hintEl.textContent = biText(zh, '')
      hintEl.hidden = false
    }

    const closeAllThreadMenus = () => {
      box.querySelectorAll('.agent-trace-thread-menu').forEach((m) => {
        m.hidden = true
      })
    }

    const renderButtons = (threads) => {
      const list = Array.isArray(threads) ? threads : []
      lastThreadList = list
      box.innerHTML = ''
      list
        .filter((t) => {
          if (!q) return true
          const tid = String(t.thread_id || '').toLowerCase()
          const title = sessionDisplayTitle(t.thread_id, threadTitleMap).toLowerCase()
          return tid.includes(q) || title.includes(q)
        })
        .forEach((t) => {
          const tid = String(t.thread_id || '').trim()
          const row = document.createElement('div')
          row.className =
            'agent-trace-thread-row' + (tid === cur ? ' agent-trace-thread-row--active' : '')

          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'agent-trace-thread-btn'
          const timeLabel = t.updated_at_ms != null ? formatMs(t.updated_at_ms) : '?'
          const sessionTitle = sessionDisplayTitle(tid, threadTitleMap)
          b.innerHTML = `
            <span class="agent-trace-thread-title">${escHtml(sessionTitle)}</span>
            <span class="agent-trace-thread-id">${escHtml(tid)}</span>
            <span class="agent-trace-thread-time">${escHtml(timeLabel)}</span>`
          b.addEventListener('click', () => {
            closeAllThreadMenus()
            navigateAgentTrace(tid)
          })

          const actions = document.createElement('div')
          actions.className = 'agent-trace-thread-actions'

          const more = document.createElement('button')
          more.type = 'button'
          more.className = 'agent-trace-thread-more'
          more.setAttribute('aria-label', biText('更多操作', 'More actions'))
          more.textContent = '\u22ef'

          const menu = document.createElement('div')
          menu.className = 'agent-trace-thread-menu'
          menu.hidden = true
          menu.dataset.threadId = tid
          menu.innerHTML = `
            <button type="button" class="agent-trace-thread-menu-item" data-act="reload">${biHtml(AT.reloadZh, AT.reloadEn)}</button>
            <button type="button" class="agent-trace-thread-menu-item" data-act="copy-export">${biHtml(AT.copyExportZh, AT.copyExportEn)}</button>
            <button type="button" class="agent-trace-thread-menu-item" data-act="open-export">${biHtml(AT.openExportZh, AT.openExportEn)}</button>`

          more.addEventListener('click', (e) => {
            e.stopPropagation()
            e.preventDefault()
            const wasOpen = !menu.hidden
            closeAllThreadMenus()
            menu.hidden = wasOpen
          })

          menu.addEventListener('click', (e) => {
            e.stopPropagation()
            const item = e.target.closest('[data-act]')
            if (!item) return
            const act = item.getAttribute('data-act')
            const threadId = menu.dataset.threadId || tid
            closeAllThreadMenus()
            if (act === 'reload') {
              if (getRouteThreadId() !== threadId) navigateAgentTrace(threadId)
              else {
                void loadThreadList()
                void loadData()
              }
            } else if (act === 'copy-export') {
              const u = `${window.location.origin}/api/debug/agent-trace/export?thread_id=${encodeURIComponent(threadId)}`
              navigator.clipboard.writeText(u).then(
                () => toast(biText('\u5df2\u590d\u5236\u5bfc\u51fa\u94fe\u63a5', 'Export URL copied'), 'success'),
                () => toast(u, 'info'),
              )
            } else if (act === 'open-export') {
              const u = `${window.location.origin}/api/debug/agent-trace/export?thread_id=${encodeURIComponent(threadId)}`
              window.open(u, '_blank')
            }
          })

          actions.append(more, menu)
          row.append(b, actions)
          box.appendChild(row)
        })
      if (!list.length) {
        box.innerHTML = `<div class="form-hint" style="padding:12px">${biHtml(AT.emptyThreadsZh, AT.emptyThreadsEn)}</div>`
      }
    }
    renderThreadButtonsRef = renderButtons

    let hintMode = null

    try {
      const obsOn = await isObservabilityEnabled()
      if (obsOn) {
        try {
          const obs = await api.observabilityThreads(
            { page: '1', page_size: '100' },
            { silent: true, timeoutMs: 8000 },
          )
          if (obs && Array.isArray(obs.items)) {
            const threads = obs.items
              .map((row) => ({
                thread_id: row.thread_id != null ? String(row.thread_id).trim() : '',
                updated_at_ms: epochMsFromAny(row.last_seen_at),
              }))
              .filter((t) => t.thread_id)
            hintMode = 'sqlite'
            applyHint(hintMode)
            renderButtons(threads)
            return
          }
        } catch {
          hintMode = 'fallback'
          applyHint(hintMode)
        }
      }

      const data = await api.agentTraceRecentThreads(80, { silent: true, timeoutMs: 8000 })
      const threads = data.threads || []
      if (hintMode == null) {
        applyHint('log')
      }
      renderButtons(threads)
    } catch (e) {
      const detail = String(e?.message || e)
      if (/404|EVOFLOW_DEBUG_TRACE_UI|debug trace/i.test(detail)) {
        page.querySelector('#at-banner').style.display = 'block'
        page.querySelector('#at-banner').innerHTML = `<p class="agent-trace-banner-line" lang="zh-CN">${AT.apiDisabledZh}</p>`
      } else if (/failed to fetch|empty response|gateway|timeout|502|503/i.test(detail)) {
        page.querySelector('#at-banner').style.display = 'block'
        page.querySelector('#at-banner').innerHTML =
          `<p class="agent-trace-banner-line" lang="zh-CN">Gateway 不可用或正在重启，会话列表暂时无法加载。请确认后端已启动后点击刷新或切换模块重试。</p>`
        box.innerHTML = `<div class="form-hint" style="padding:12px">Gateway 未响应，请检查后端是否运行在正确端口。</div>`
      }
    }
  }

  async function loadData() {
    const tid = getRouteThreadId()
    const statusEl = page.querySelector('#at-status')
    ensureSessionTitlesBackground()
    const banner = page.querySelector('#at-banner')
    banner.style.display = 'none'
    banner.classList.remove('agent-trace-banner--err')

    if (!tid) {
      page.querySelector('#at-summary').innerHTML = ''
      page.querySelector('#at-timeline').innerHTML = `<p class="form-hint">${biHtml(AT.chooseSessionHintZh, AT.chooseSessionHintEn)}</p>`
      page.querySelector('#at-raw-panel').innerHTML = ''
      renderTurnSidebar(page, null)
      statusEl.textContent = biText(AT.noThreadZh, AT.noThreadEn)
      currentPayload = null
      return
    }

    page.querySelector('#at-tid-manual').value = tid
    statusEl.textContent = biText(AT.loadingZh, AT.loadingEn)

    try {
      const j = await api.agentTraceData(tid)
      currentPayload = j
      const ct = j.conversation_turns || {}
      const turns = asArray(ct.turns)
      let idx = 0
      if (turns.length) {
        idx = resolveTurnIndexFromRoute(turns)
        normalizeAgentTraceHash(tid, idx)
      }

      renderTurnSummary(page.querySelector('#at-summary'), j, idx)
      renderTurnSidebar(page, j, idx, onPickTurn)
      renderTurnTimeline(page.querySelector('#at-timeline'), currentPayload, idx)
      showRawPanel()

      statusEl.innerHTML = `<div class="at-session-head">
        <span class="at-session-head-title">${escHtml(sessionDisplayTitle(tid, threadTitleMap))}</span>
        <span class="at-session-head-id">${escHtml(tid)}</span>
      </div>`
      if (!j.langgraph || !j.langgraph.ok) {
        const err = (j.langgraph && j.langgraph.error) || ''
        if (err) {
          banner.style.display = 'block'
          banner.textContent = `${biText(AT.lgFetchFailZh, AT.lgFetchFailEn)}${err}`
        }
      }
    } catch (e) {
      const msg = String(e?.message || e)
      currentPayload = null
      page.querySelector('#at-summary').innerHTML = ''
      page.querySelector('#at-timeline').innerHTML = ''
      page.querySelector('#at-raw-panel').innerHTML = ''
      renderTurnSidebar(page, null)
      if (/404|EVOFLOW_DEBUG_TRACE_UI/i.test(msg)) {
        banner.style.display = 'block'
        banner.innerHTML = `<p class="agent-trace-banner-line" lang="zh-CN">${AT.debugOffZh}</p>`
      } else {
        banner.style.display = 'block'
        banner.textContent = msg
      }
      statusEl.textContent = biText(AT.loadFailedStatusZh, AT.loadFailedStatusEn)
      toast(msg, 'error')
    }
  }

  page.querySelector('#at-filter').addEventListener('input', () => loadThreadList())
  page.querySelector('#at-open-manual').addEventListener('click', () => {
    const tid = (page.querySelector('#at-tid-manual').value || '').trim()
    if (!tid) {
      toast(biText('\u8bf7\u8f93\u5165 thread_id', 'Enter thread_id'), 'warning')
      return
    }
    navigateAgentTrace(tid)
  })

  document.addEventListener('click', (e) => {
    if (e.target.closest('.agent-trace-thread-more') || e.target.closest('.agent-trace-thread-menu')) return
    page.querySelectorAll('.agent-trace-thread-menu').forEach((m) => {
      m.hidden = true
    })
  })

  page.querySelector('#at-live').addEventListener('change', (e) => {
    if (_pollTimer) clearInterval(_pollTimer)
    _pollTimer = null
    if (e.target.checked) {
      _pollTimer = window.setInterval(() => {
        void loadData()
      }, 3000)
    }
  })

  page.querySelector('#at-tid-manual').value = getRouteThreadId()

  const onAgentTraceHashSync = () => {
    const h = window.location.hash.slice(1) || ''
    const path = h.split('?')[0]
    if (path !== '/debug/agent-trace') return
    switchMenu('sessions')
    void loadThreadList()
    void loadData()
  }
  window.addEventListener('hashchange', onAgentTraceHashSync)
  _detachAgentTraceHashSync = () => window.removeEventListener('hashchange', onAgentTraceHashSync)

  const routeTid = getRouteThreadId()
  if (routeTid) switchMenu('sessions')
  else switchMenuPanel('overview')

  return page
}
