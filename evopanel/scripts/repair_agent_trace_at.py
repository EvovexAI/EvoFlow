# -*- coding: utf-8 -*-
from pathlib import Path
import re

p = Path(__file__).resolve().parents[1] / "src" / "pages" / "agent-trace.js"
orig = p.read_text(encoding="utf-8", errors="replace")
s = orig

box_i = orig.index("  const box = document.createElement('motionless-placeholder')") if False else orig.index("  const box = document.createElement('div')")
box_end = orig.index("  card.appendChild(box)\n}", box_i) + len("  card.appendChild(box)\n}")
kf_tail = orig[box_i:box_end]


def swap(fn_start: str, fn_next: str, body: str) -> None:
    global s
    a = s.index(fn_start)
    b = s.index(fn_next, a)
    s = s[:a] + body + s[b:]


swap(
    "function timelineRailPhaseTextInner(ev, phaseCarry) {",
    "\n/**\n * @param {{ hideCycleBanner?: boolean }}",
    """function timelineRailPhaseTextInner(ev, phaseCarry) {
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

""",
)

kf_body = r"""function renderTimelineKeyFacts(card, ev) {
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
      if (data.elapsed_ms != null) parts.push({ k: biText(K.elapsedZh, 'Elapsed'), v: `${String(data.elapsed_ms)} ms` })
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
      if (data.elapsed_ms != null) parts.push({ k: biText(K.elapsedZh, 'Elapsed'), v: `${String(data.elapsed_ms)} ms` })
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
    const mid = rec.model != null && String(rec.model).trim() ? String(rec.model).trim() : EM_DASH
    parts.push({ k: biText(AT.meta.modelIdZh, AT.meta.modelIdEn), v: mid })
    const turns = payloadContextUserTurnCount(rec)
    parts.push({ k: biText(AT.meta.contextTurnsZh, AT.meta.contextTurnsEn), v: turns != null ? String(turns) : EM_DASH })
    const pl = rec.payload
    const think = inferThinkingEnabledFromPayload(pl && typeof pl === 'object' ? pl : null)
    parts.push({ k: biText(AT.meta.thinkingEnabledZh, AT.meta.thinkingEnabledEn), v: formatThinkingLabel(think) })
    const tnames = toolNamesFromVendorPayload(pl && typeof pl === 'object' ? pl : null)
    parts.push({ k: biText(AT.meta.requestToolsListZh, AT.meta.requestToolsListEn), v: tnames.length ? tnames.join(LIST_SEP) : EM_DASH })
  } else if (kind === 'tool') {
    const rec = /** @type {Record<string, unknown>} */ (data)
    if (rec.input != null) parts.push({ k: biText(AT.detailKeys.toolInputZh, AT.detailKeys.toolInputEn), v: safeJsonPreview(rec.input, 1400) })
    if (rec.output != null) parts.push({ k: biText(AT.detailKeys.toolOutputZh, AT.detailKeys.toolOutputEn), v: safeJsonPreview(rec.output, 1400) })
  } else if (kind === 'round') {
    const ui = data.user_input != null ? String(data.user_input).trim() : ''
    if (ui) parts.push({ k: biText(K.userInputZh, 'User'), v: trunc(ui, 320) })
    const tools = asStringList(data.model_request_tools)
    if (tools.length) parts.push({ k: biText(K.toolListZh, 'Tools'), v: tools.join(LIST_SEP) })
    if (data.model_request_tools_count != null) parts.push({ k: biText(K.toolCountZh, 'Tool count'), v: String(data.model_request_tools_count) })
  }

  if (!parts.length) return

""" + kf_tail + "\n"

swap(
    "function renderTimelineKeyFacts(card, ev) {",
    "\n/**\n * ??????????????????????????",
    kf_body,
)

sum_a = s.index("  let tpsLine = ''", s.index("function renderSummary"))
sum_b = s.index("    .join('')", sum_a) + len("    .join('')")
map_tail = orig[sum_a:sum_b]
# replace only metrics content inside map_tail by rebuilding
sum_new = """  let tpsLine = ''
  if (tps && tps.ok) {
    const subs = asArray(tps.subtasks)
    const mt = tps.main_task && typeof tps.main_task === 'object' ? tps.main_task : {}
    tpsLine = `${biText(AT.sum.mainTaskZh, 'Main task')} ${escHtml(String(mt.status ?? EM_DASH))} ${MID_DOT} ${biText(AT.sum.subtasksZh, 'Subtasks')} ${subs.length}`
  } else if (tps && !tps.ok) {
    tpsLine = `${biText(AT.sum.snapshotFailedZh, 'Snapshot failed')} ${escHtml(trunc(String(tps.error || tps.error_type || ''), 40))}`
  } else {
    tpsLine = biText(AT.sum.taskSnapshotZh, 'Task snapshot') + ` ${EM_DASH}`
  }
  const tuLine = tu
    ? `${biText(tu.fetch_ok ? AT.sum.lgStateOkZh : AT.sum.lgStateFailZh, '')} ${MID_DOT} UI AI ${tuTot.ui_messages_ai_count ?? EM_DASH} / messages AI ${tuTot.messages_ai_count ?? EM_DASH}`
    : biText(AT.sum.tokenDebugZh, 'Token debug') + ` ${EM_DASH}`

  const csd = payload.claude_sessions_debug && typeof payload.claude_sessions_debug === 'object' ? payload.claude_sessions_debug : {}
  const csSessions = asArray(csd.sessions)
  const csFound = csSessions.filter((x) => x && typeof x === 'object' && x.found).length
  const csVal = csSessions.length > 0 ? `${String(csFound)}/${String(csSessions.length)}` : EM_DASH

  const metrics = [
    { zh: AT.sum.turnsZh, en: 'Turns', v: cnt.turns ?? EM_DASH },
    { zh: AT.sum.modelStepsZh, en: 'Model steps', v: cnt.model_cycles ?? EM_DASH },
    { zh: AT.sum.collabRowsZh, en: 'Collab rows', v: asArray(payload.collab_cycle).length },
    { zh: AT.sum.lifecycleRowsZh, en: 'Lifecycle rows', v: asArray(payload.task_lifecycle_trace).length },
    { zh: AT.sum.vendorRowsZh, en: 'Vendor HTTP rows', v: asArray(payload.model_request_payloads).length },
    { zh: AT.sum.roundRowsZh, en: 'Round trace rows', v: asArray(payload.lead_agent_round).length },
    { zh: AT.sum.toolCallsZh, en: 'Tool calls', v: asArray(payload.tool_call_io).length },
    { zh: AT.summaryClaudeSessionsZh, en: AT.summaryClaudeSessionsEn, v: csVal },
    { zh: AT.sum.graphRunsZh, en: 'Graph runs', v: asArray(payload.langgraph && payload.langgraph.runs).length },
    { zh: AT.sum.superstepLbZh, en: 'Superstep LB', v: lb != null ? String(lb) : EM_DASH },
    { zh: AT.sum.recursionLimitZh, en: 'Recursion limit', v: lr != null ? String(lr) : EM_DASH },
  ]
"""
map_start = orig.index("    .map(", sum_a)
sum_new = sum_new + orig[map_start:sum_b]
s = s[:sum_a] + sum_new + s[sum_b:]

subs = [
    ("return body ? `? ${ci} ?\\n${body}` : `? ${ci} ?`", "return body ? `\\u7b2c ${ci} \\u6b21\\n${body}` : `\\u7b2c ${ci} \\u6b21`"),
    ("title: String(turn.label || '').trim() || biText('????', 'User input'),", "title: String(turn.label || '').trim() || biText(AT.kf.userInputZh, 'User input'),"),
    ("const label = turn.label || `? ${idx + 1} ?`", "const label = turn.label || biText(AT.turnLabelNthZh(idx + 1), AT.turnLabelNthEn(idx + 1))"),
    ("if (ms == null || ms === '') return '?'", "if (ms == null || ms === '') return EM_DASH"),
    ("if (v == null || v === '') return '?'", "if (v == null || v === '') return EM_DASH"),
    ("return t.slice(0, n - 1) + '?'", "return t.slice(0, n - 1) + '\\u2026'"),
    ("return String(v).length > 28 ? String(v).slice(0, 25) + '?' : String(v)", "return String(v).length > 28 ? String(v).slice(0, 25) + '\\u2026' : String(v)"),
    ("dot.textContent = '?'", "dot.textContent = MID_DOT"),
    ("s.textContent = '?'", "s.textContent = MID_DOT"),
    ("const j = tools.join('?')", "const j = tools.join(LIST_SEP)"),
    ("if (line !== '?') return line", "if (line !== EM_DASH) return line"),
    ("? sc.map((x) => String(x)).filter(Boolean).join('?')", "? sc.map((x) => String(x)).filter(Boolean).join(LIST_SEP)"),
    ("${escHtml(display || '?')}", "${escHtml(display || EM_DASH)}"),
    ("toast('??? thread_id', 'warning')", "toast(biText('\\u8bf7\\u8f93\\u5165 thread_id', 'Enter thread_id'), 'warning')"),
    ("toast('??????', 'warning')", "toast(biText(AT.pickSessionZh, AT.pickSessionEn), 'warning')"),
    ("toast('???????', 'success')", "toast(biText('\\u5df2\\u590d\\u5236\\u5bfc\\u51fa\\u94fe\\u63a5', 'Export URL copied'), 'success')"),
]
for a, b in subs:
    if a in s:
        s = s.replace(a, b)

# phase fold join
s = re.sub(
    r"if \(phase && userLine\) return `\$\{phase\} [^\$]+\$\{userLine\}`",
    "if (phase && userLine) return `${phase} ${MID_DOT} ${userLine}`",
    s,
    count=1,
)

for pat in [
    r"(\$\{biText\(AT\.prefixes\.lifecycleZh, AT\.prefixes\.lifecycleEn\)\}) [^\$]+(\$\{String\(row\.event)",
    r"(\$\{biText\(AT\.prefixes\.modelCallZh, AT\.prefixes\.modelCallEn\)\}) [^\$]+(\$\{row\.model_call_seq)",
    r"(\$\{biText\(AT\.prefixes\.roundZh, AT\.prefixes\.roundEn\)\}) [^\$]+(\$\{evName)",
    r"(\$\{biText\(AT\.modelHttpDebugTitleZh, AT\.modelHttpDebugTitleEn\)\}) [^\$]+(\$\{modelStr)",
    r"(\$\{biText\(AT\.prefixes\.toolZh, AT\.prefixes\.toolEn\)\}) [^\$]+(\$\{rec\.tool_name)",
]:
    s = re.sub(pat, r"\1 ${MID_DOT} \2", s, count=1)

s = re.sub(
    r"(\[row\.main_task_id, row\.subtask_id, row\.status\]\.filter\(Boolean\)\.join\(')[^']+('\))",
    r"\1 ${MID_DOT} \2",
    s,
    count=1,
)
s = re.sub(
    r"subtitle: `\$\{st \|\| '\?'\}\$\{rec\.duration_ms != null \? ` [^`]+ ms` : ''\}`",
    "subtitle: `${st || EM_DASH}${rec.duration_ms != null ? ` ${MID_DOT} ${rec.duration_ms} ms` : ''}`",
    s,
    count=1,
)

p.write_text(s, encoding="utf-8", newline="\n")
print("ok", p)
