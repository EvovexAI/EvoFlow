# -*- coding: utf-8 -*-
"""Repair corrupted Chinese / separators in agent-trace.js (ASCII-only script)."""
from pathlib import Path

p = Path(__file__).resolve().parents[1] / "src" / "pages" / "agent-trace.js"
s = p.read_text(encoding="utf-8", errors="replace")

# Order: longer / more specific first
REPLS = [
    # --- timeline rail ---
    ("if (!actionLine) return showPhase && phaseLabel ? `???${phaseLabel}` : ''", "if (!actionLine) return showPhase && phaseLabel ? `\u9636\u6bb5\u00b7${phaseLabel}` : ''"),
    ("return `${actionLine}?${phaseLabel}?`", "return `${actionLine}\u00b7${phaseLabel}`"),
    ("return railWithDedupedPhase('????', phaseCarry, phaseStr)", "return railWithDedupedPhase('\u7528\u6237\u8f93\u5165', phaseCarry, phaseStr)"),
    ("return railWithDedupedPhase('???????', phaseCarry, phaseStr)", "return railWithDedupedPhase('\u6a21\u578b\u8c03\u5ea6', phaseCarry, phaseStr)"),
    ("return railWithDedupedPhase('????', phaseCarry, phaseStr)", "return railWithDedupedPhase('\u5de5\u5177', phaseCarry, phaseStr)"),
    ("const detail = evn && st ? `${evn} ? ${st}` : evn || st || ''", "const detail = evn && st ? `${evn} \u00b7 ${st}` : evn || st || ''"),
    ("const actionLine = detail ? `???? ? ${detail}` : '????'", "const actionLine = detail ? `\u4efb\u52a1\u751f\u547d\u5468\u671f \u00b7 ${detail}` : '\u4efb\u52a1\u751f\u547d\u5468\u671f'"),
    ("return body ? `?${ci}?\\n${body}` : `?${ci}?`", "return body ? `\u7b2c ${ci} \u6b21\\n${body}` : `\u7b2c ${ci} \u6b21`"),
    # --- fold / banner ---
    ("if (phase && userLine) return `${phase} ? ${userLine}`", "if (phase && userLine) return `${phase} \u00b7 ${userLine}`"),
    ("toolsStr = `${String(c.model_request_tools_count)} ??????`", "toolsStr = `${String(c.model_request_tools_count)} \u4e2a\u5de5\u5177`"),
    ("dot.textContent = '?'", "dot.textContent = '\u00b7'"),
    ("s.textContent = '?'", "s.textContent = '\u00b7'"),
    # --- formatActivatedScenariosForBanner ---
    ("if (v == null) return '?'", "if (v == null) return '\u2014'"),
    ("return parts.length ? parts.join('?') : '?'", "return parts.length ? parts.join('\u3001') : '\u2014'"),
    ("return s || '?'", "return s || '\u2014'"),
    ("if (line !== '?') return line", "if (line !== '\u2014') return line"),
    # --- trunc / formatMs ---
    ("if (ms == null || ms === '') return '?'", "if (ms == null || ms === '') return '\u2014'"),
    ("if (v == null || v === '') return '?'", "if (v == null || v === '') return '\u2014'"),
    ("return t.slice(0, n - 1) + '?'", "return t.slice(0, n - 1) + '\u2026'"),
    ("return String(v).length > 28 ? String(v).slice(0, 25) + '?' : String(v)", "return String(v).length > 28 ? String(v).slice(0, 25) + '\u2026' : String(v)"),
    ("toolsStr = j.length > _MCB_TOOLS_MAX ? j.slice(0, _MCB_TOOLS_MAX - 1) + '?' : j", "toolsStr = j.length > _MCB_TOOLS_MAX ? j.slice(0, _MCB_TOOLS_MAX - 1) + '\u2026' : j"),
    # --- renderTimelineKeyFacts model_call ---
    ("if (tools.length) parts.push({ k: '??????', v: tools.join('?') })", "if (tools.length) parts.push({ k: '\u5de5\u5177\u5217\u8868', v: tools.join('\u3001') })"),
    ("parts.push({ k: '??????', v: `${String(cnt)}???????` })", "parts.push({ k: '\u9644\u5e26\u5de5\u5177', v: `${String(cnt)} \u4e2a` })"),
    ("else parts.push({ k: '??????', v: '???' })", "else parts.push({ k: '\u5de5\u5177\u5217\u8868', v: '\u65e0' })"),
    ("if (def.length) parts.push({ k: '????', v: def.join('?') })", "if (def.length) parts.push({ k: '\u5ef6\u8fdf\u52a0\u8f7d\u5de5\u5177', v: def.join('\u3001') })"),
    ("if (ui) parts.push({ k: '??????', v: trunc(ui, 280) })", "if (ui) parts.push({ k: '\u7528\u6237\u8f93\u5165', v: trunc(ui, 280) })"),
    # --- collab keyfacts ---
    ("if (setDiff) parts.push({ k: '????', v: collabPhaseLabelZh(setp) })", "if (setDiff) parts.push({ k: '\u5199\u5165\u9636\u6bb5', v: collabPhaseLabelZh(setp) })"),
    ("parts.push({ k: '????', v: collabPhaseLabelZh(toP) })", "parts.push({ k: '\u76ee\u6807\u9636\u6bb5', v: collabPhaseLabelZh(toP) })"),
    ("parts.push({ k: '????', v: String(data.source) })", "parts.push({ k: '\u6765\u6e90', v: String(data.source) })"),
    ("if (tools.length) parts.push({ k: '??????????', v: tools.join('?') })", "if (tools.length) parts.push({ k: '\u8bf7\u6c42\u5de5\u5177\u5217\u8868', v: tools.join('\u3001') })"),
    ("else if (n != null) parts.push({ k: '?????', v: `${String(n)}???????` })", "else if (n != null) parts.push({ k: '\u9644\u5e26\u5de5\u5177\u6570', v: `${String(n)} \u4e2a` })"),
    ("if (data.message_count != null) parts.push({ k: '????', v: String(data.message_count) })", "if (data.message_count != null) parts.push({ k: '\u6d88\u606f\u6761\u6570', v: String(data.message_count) })"),
    ("if (data.last_message_type) parts.push({ k: '??????', v: String(data.last_message_type) })", "if (data.last_message_type) parts.push({ k: '\u6700\u540e\u6d88\u606f\u7c7b\u578b', v: String(data.last_message_type) })"),
    ("if (lup) parts.push({ k: '??????', v: trunc(lup, 420) })", "if (lup) parts.push({ k: '\u7528\u6237\u9884\u89c8', v: trunc(lup, 420) })"),
    ("if (rt.length) parts.push({ k: '???????', v: rt.join('?') })", "if (rt.length) parts.push({ k: '\u8fd4\u56de tool_calls', v: rt.join('\u3001') })"),
    ("if (data.elapsed_ms != null) parts.push({ k: '??', v: `${String(data.elapsed_ms)} ms` })", "if (data.elapsed_ms != null) parts.push({ k: '\u8017\u65f6', v: `${String(data.elapsed_ms)} ms` })"),
    ("if (ap) parts.push({ k: '??????', v: trunc(ap, 520) })", "if (ap) parts.push({ k: 'AI \u9884\u89c8', v: trunc(ap, 520) })"),
    ("parts.push({ k: '?? tool_calls', v: String(data.invalid_tool_calls_count) })", "parts.push({ k: '\u65e0\u6548 tool_calls', v: String(data.invalid_tool_calls_count) })"),
    ("if (ft.length) parts.push({ k: '?? AI ????', v: ft.join('?') })", "if (ft.length) parts.push({ k: '\u6700\u7ec8 AI tool_calls', v: ft.join('\u3001') })"),
    ("if (fp) parts.push({ k: '??????', v: trunc(fp, 620) })", "if (fp) parts.push({ k: '\u6700\u7ec8 AI \u9884\u89c8', v: trunc(fp, 620) })"),
    ("if (data.tool_name) parts.push({ k: '??', v: String(data.tool_name) })", "if (data.tool_name) parts.push({ k: '\u5de5\u5177', v: String(data.tool_name) })"),
    ("if (data.result_type) parts.push({ k: '????', v: String(data.result_type) })", "if (data.result_type) parts.push({ k: '\u7ed3\u679c\u7c7b\u578b', v: String(data.result_type) })"),
    ("if (rp) parts.push({ k: '????', v: trunc(rp, 900) })", "if (rp) parts.push({ k: '\u7ed3\u679c\u9884\u89c8', v: trunc(rp, 900) })"),
    # lifecycle keyfacts (after tool_name lines - duplicate k:'??' for lifecycle)
    ("if (data.event) parts.push({ k: '??', v: String(data.event) })", "if (data.event) parts.push({ k: '\u4e8b\u4ef6', v: String(data.event) })"),
    ("if (data.status) parts.push({ k: '??', v: String(data.status) })", "if (data.status) parts.push({ k: '\u72b6\u6001', v: String(data.status) })"),
    ("if (data.main_task_id) parts.push({ k: '???', v: String(data.main_task_id) })", "if (data.main_task_id) parts.push({ k: '\u4e3b\u4efb\u52a1', v: String(data.main_task_id) })"),
    ("if (data.subtask_id) parts.push({ k: '???', v: String(data.subtask_id) })", "if (data.subtask_id) parts.push({ k: '\u5b50\u4efb\u52a1', v: String(data.subtask_id) })"),
    ("v: tnames.length ? tnames.join('?') : '?'", "v: tnames.length ? tnames.join('\u3001') : '\u2014'"),
    ("if (rec.input != null) parts.push({ k: '????', v: safeJsonPreview(rec.input, 1400) })", "if (rec.input != null) parts.push({ k: '\u5de5\u5177\u5165\u53c2', v: safeJsonPreview(rec.input, 1400) })"),
    ("if (rec.output != null) parts.push({ k: '????', v: safeJsonPreview(rec.output, 1400) })", "if (rec.output != null) parts.push({ k: '\u5de5\u5177\u51fa\u53c2', v: safeJsonPreview(rec.output, 1400) })"),
    ("if (ui) parts.push({ k: '????', v: trunc(ui, 320) })", "if (ui) parts.push({ k: '\u7528\u6237\u8f93\u5165', v: trunc(ui, 320) })"),
    ("if (tools.length) parts.push({ k: '??????', v: tools.join('?') })", "if (tools.length) parts.push({ k: '\u5de5\u5177\u5217\u8868', v: tools.join('\u3001') })"),
    ("parts.push({ k: '???', v: String(data.model_request_tools_count) })", "parts.push({ k: '\u5de5\u5177\u6570', v: String(data.model_request_tools_count) })"),
    # buildTurnTimelineEvents titles
    ("title: String(turn.label || '').trim() || biText('????', 'User input'),", "title: String(turn.label || '').trim() || biText('\u7528\u6237\u8f93\u5165', 'User input'),"),
    ("title: `${biText(AT.prefixes.lifecycleZh, AT.prefixes.lifecycleEn)} ? ${String(row.event || '').slice(0, 72)}`,", "title: `${biText(AT.prefixes.lifecycleZh, AT.prefixes.lifecycleEn)} \u00b7 ${String(row.event || '').slice(0, 72)}`,"),
    ("subtitle: [row.main_task_id, row.subtask_id, row.status].filter(Boolean).join(' ? ') || formatMs(ts),", "subtitle: [row.main_task_id, row.subtask_id, row.status].filter(Boolean).join(' \u00b7 ') || formatMs(ts),"),
    ("title: `${biText(AT.prefixes.modelCallZh, AT.prefixes.modelCallEn)} ? seq ${row.model_call_seq != null ? row.model_call_seq : '?'}`,", "title: `${biText(AT.prefixes.modelCallZh, AT.prefixes.modelCallEn)} \u00b7 seq ${row.model_call_seq != null ? row.model_call_seq : '\u2014'}`,"),
    ("title: `${biText(AT.prefixes.roundZh, AT.prefixes.roundEn)} ? ${evName || 'record'}`,", "title: `${biText(AT.prefixes.roundZh, AT.prefixes.roundEn)} \u00b7 ${evName || 'record'}`,"),
    ("title: `${biText(AT.modelHttpDebugTitleZh, AT.modelHttpDebugTitleEn)} ? ${modelStr}`,", "title: `${biText(AT.modelHttpDebugTitleZh, AT.modelHttpDebugTitleEn)} \u00b7 ${modelStr}`,"),
    ("title: `${biText(AT.prefixes.toolZh, AT.prefixes.toolEn)} ? ${rec.tool_name || 'unknown'}`,", "title: `${biText(AT.prefixes.toolZh, AT.prefixes.toolEn)} \u00b7 ${rec.tool_name || 'unknown'}`,"),
    ("subtitle: `${st || '?'}${rec.duration_ms != null ? ` ? ${rec.duration_ms} ms` : ''}`,", "subtitle: `${st || '\u2014'}${rec.duration_ms != null ? ` \u00b7 ${rec.duration_ms} ms` : ''}`,"),
    # renderSummary
    ("tpsLine = `${biText('???', 'Main task')} ${escHtml(String(mt.status ?? '?'))} ? ${biText('???', 'Subtasks')} ${subs.length}`", "tpsLine = `${biText('\u4e3b\u4efb\u52a1', 'Main task')} ${escHtml(String(mt.status ?? '\u2014'))} \u00b7 ${biText('\u5b50\u4efb\u52a1', 'Subtasks')} ${subs.length}`"),
    ("tpsLine = `${biText('????', 'Snapshot failed')} ${escHtml(trunc(String(tps.error || tps.error_type || ''), 40))}`", "tpsLine = `${biText('\u5feb\u7167\u5931\u8d25', 'Snapshot failed')} ${escHtml(trunc(String(tps.error || tps.error_type || ''), 40))}`"),
    ("tpsLine = biText('????', 'Task snapshot') + ' ?'", "tpsLine = biText('\u4efb\u52a1\u5feb\u7167', 'Task snapshot') + ' \u2014'"),
    ("`${biText(tu.fetch_ok ? 'LangGraph state ???' : 'state ???', tu.fetch_ok ? 'LangGraph state OK' : 'state not fetched')} ? UI AI ${tuTot.ui_messages_ai_count ?? '?'} / messages AI ${tuTot.messages_ai_count ?? '?'}`", "`${biText(tu.fetch_ok ? 'LangGraph state \u5df2\u62c9\u53d6' : 'state \u672a\u62c9\u53d6', tu.fetch_ok ? 'LangGraph state OK' : 'state not fetched')} \u00b7 UI AI ${tuTot.ui_messages_ai_count ?? '\u2014'} / messages AI ${tuTot.messages_ai_count ?? '\u2014'}`"),
    (": biText('Token ??', 'Token debug') + ' ?'", ": biText('Token \u8c03\u8bd5', 'Token debug') + ' \u2014'"),
    ("const csVal = csSessions.length > 0 ? `${String(csFound)}/${String(csSessions.length)}` : '?'", "const csVal = csSessions.length > 0 ? `${String(csFound)}/${String(csSessions.length)}` : '\u2014'"),
    ("{ zh: '???', en: 'Turns', v: cnt.turns ?? '?' },", "{ zh: '\u5bf9\u8bdd\u8f6e\u6b21', en: 'Turns', v: cnt.turns ?? '\u2014' },"),
    ("{ zh: '?????', en: 'Model steps', v: cnt.model_cycles ?? '?' },", "{ zh: '\u6a21\u578b\u4ea4\u4e92', en: 'Model steps', v: cnt.model_cycles ?? '\u2014' },"),
    ("{ zh: '????', en: 'Collab rows', v: asArray(payload.collab_cycle).length },", "{ zh: '\u534f\u4f5c\u884c', en: 'Collab rows', v: asArray(payload.collab_cycle).length },"),
    ("{ zh: '????', en: 'Lifecycle rows', v: asArray(payload.task_lifecycle_trace).length },", "{ zh: '\u751f\u547d\u5468\u671f\u884c', en: 'Lifecycle rows', v: asArray(payload.task_lifecycle_trace).length },"),
    ("{ zh: '????', en: 'Vendor HTTP rows', v: asArray(payload.model_request_payloads).length },", "{ zh: '\u5382\u5546\u8bf7\u6c42\u884c', en: 'Vendor HTTP rows', v: asArray(payload.model_request_payloads).length },"),
    ("{ zh: '????', en: 'Round trace rows', v: asArray(payload.lead_agent_round).length },", "{ zh: '\u56de\u5408\u8ffd\u8e2a\u884c', en: 'Round trace rows', v: asArray(payload.lead_agent_round).length },"),
    ("{ zh: '????', en: 'Tool calls', v: asArray(payload.tool_call_io).length },", "{ zh: '\u5de5\u5177\u8c03\u7528', en: 'Tool calls', v: asArray(payload.tool_call_io).length },"),
    ("{ zh: '???', en: 'Graph runs', v: asArray(payload.langgraph && payload.langgraph.runs).length },", "{ zh: '\u56fe\u8fd0\u884c', en: 'Graph runs', v: asArray(payload.langgraph && payload.langgraph.runs).length },"),
    ("{ zh: '?????', en: 'Superstep LB ?', v: lb != null ? String(lb) : '?' },", "{ zh: 'Superstep \u4e0b\u754c', en: 'Superstep LB', v: lb != null ? String(lb) : '\u2014' },"),
    ("{ zh: '????', en: 'Recursion limit', v: lr != null ? String(lr) : '?' },", "{ zh: '\u9012\u5f52\u4e0a\u9650', en: 'Recursion limit', v: lr != null ? String(lr) : '\u2014' },"),
    # user card activated scenarios join
    ("? sc.map((x) => String(x)).filter(Boolean).join('?')", "? sc.map((x) => String(x)).filter(Boolean).join('\u3001')"),
    ("${escHtml(display || '?')}", "${escHtml(display || '\u2014')}"),
    # claude sessions
    ("const src = srcArr.map(String).filter(Boolean).join('?')", "const src = srcArr.map(String).filter(Boolean).join('\u3001')"),
    ("meta.textContent = ` ? ${nEv} ?` + (s.events_truncated ? '?????' : '') + (src ? ` ? ${src}` : '')", "meta.textContent = ` \u00b7 ${nEv} \u6761\u4e8b\u4ef6` + (s.events_truncated ? '\uff08\u5df2\u622a\u65ad\uff09' : '') + (src ? ` \u00b7 ${src}` : '')"),
    ("` ? ${biText(AT.claudeSessionsMissingFileZh, AT.claudeSessionsMissingFileEn)}` + (src ? ` ? ${src}` : '')", "` \u00b7 ${biText(AT.claudeSessionsMissingFileZh, AT.claudeSessionsMissingFileEn)}` + (src ? ` \u00b7 ${src}` : '')"),
    # lifecycle table
    ("hr.innerHTML = `<th class=\"idx\">#</th><th>${biHtml('??', 'Time')}</th><th>${biHtml('??', 'Event')}</th><th>${biHtml('???', 'Main task')}</th><th>${biHtml('???', 'Subtask')}</th><th>${biHtml('??', 'Status')}</th><th>${biHtml('??', 'Detail')}</th>`", "hr.innerHTML = `<th class=\"idx\">#</th><th>${biHtml('\u65f6\u95f4', 'Time')}</th><th>${biHtml('\u4e8b\u4ef6', 'Event')}</th><th>${biHtml('\u4e3b\u4efb\u52a1', 'Main task')}</th><th>${biHtml('\u5b50\u4efb\u52a1', 'Subtask')}</th><th>${biHtml('\u72b6\u6001', 'Status')}</th><th>${biHtml('\u8be6\u60c5', 'Detail')}</th>`"),
    ("<td>${escHtml(String(row.status ?? '?'))}</td>`", "<td>${escHtml(String(row.status ?? '\u2014'))}</td>`"),
    # sqlite panel hints
    ("innerHTML = '<p class=\"el-obs-hint\">?????</p>'", "innerHTML = '<p class=\"el-obs-hint\">\u52a0\u8f7d\u4e2d\u2026</p>'"),
    ("innerHTML = '<tr><td colspan=\"8\" class=\"el-obs-empty\">?????</td></tr>'", "innerHTML = '<tr><td colspan=\"8\" class=\"el-obs-empty\">\u52a0\u8f7d\u4e2d\u2026</td></tr>'"),
    ("innerHTML = '<tr><td colspan=\"7\" class=\"el-obs-empty\">?????</td></tr>'", "innerHTML = '<tr><td colspan=\"7\" class=\"el-obs-empty\">\u52a0\u8f7d\u4e2d\u2026</td></tr>'"),
    ("SQLite ????: ${escHtml", "SQLite \u52a0\u8f7d\u5931\u8d25: ${escHtml"),
    ("innerHTML = '<p class=\"el-obs-hint\">?? config.yaml ??? observability.enabled ??? SQLite ??</p>'", "innerHTML = '<p class=\"el-obs-hint\">\u8bf7\u5728 config.yaml \u5f00\u542f observability.enabled \u4ee5\u4f7f\u7528 SQLite \u89c2\u6d4b</p>'"),
    ("SQLite ??????: ${escHtml", "SQLite \u5de5\u5177\u9875\u52a0\u8f7d\u5931\u8d25: ${escHtml"),
    ("innerHTML = '<p class=\"el-obs-hint\">??? observability.enabled</p>'", "innerHTML = '<p class=\"el-obs-hint\">\u9700\u5f00\u542f observability.enabled</p>'"),
    ("innerHTML = '<tr><td colspan=\"8\" class=\"el-obs-empty\">????</td></tr>'", "innerHTML = '<tr><td colspan=\"8\" class=\"el-obs-empty\">\u6682\u65e0\u6570\u636e</td></tr>'"),
    ("innerHTML = '<tr><td colspan=\"7\" class=\"el-obs-empty\">????</td></tr>'", "innerHTML = '<tr><td colspan=\"7\" class=\"el-obs-empty\">\u6682\u65e0\u6570\u636e</td></tr>'"),
    # toasts
    ("toast('??? thread_id', 'warning')", "toast('\u8bf7\u8f93\u5165 thread_id', 'warning')"),
    ("toast('??????', 'warning')", "toast('\u8bf7\u5148\u9009\u62e9\u4f1a\u8bdd', 'warning')"),
    ("toast('???????', 'success')", "toast('\u5df2\u590d\u5236\u5bfc\u51fa\u94fe\u63a5', 'success')"),
    # tools join in appendModelCycleFold
    ("const j = tools.join('?')", "const j = tools.join('\u3001')"),
    # model http thinking line
    ("v: turns != null ? String(turns) : '?'", "v: turns != null ? String(turns) : '\u2014'"),
    ("const modelStr = rec.model != null && String(rec.model).trim() ? String(rec.model).trim() : '?'", "const modelStr = rec.model != null && String(rec.model).trim() ? String(rec.model).trim() : '\u2014'"),
    ("const mid = rec.model != null && String(rec.model).trim() ? String(rec.model).trim() : '?'", "const mid = rec.model != null && String(rec.model).trim() ? String(rec.model).trim() : '\u2014'"),
]

missing = []
for a, b in REPLS:
    if a not in s:
        missing.append(a[:80])
    else:
        s = s.replace(a, b)

p.write_text(s, encoding="utf-8", newline="\n")
print("patched", p)
if missing:
    print("MISSING", len(missing))
    for m in missing:
        print(" -", m)
