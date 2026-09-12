# -*- coding: utf-8 -*-
from pathlib import Path

p = Path(__file__).resolve().parents[1] / "src" / "pages" / "agent-trace.js"
s = p.read_text(encoding="utf-8")

repls = [
    (
        "meta.textContent = ` ? ${nEv} ???` + (s.events_truncated ? '?????' : '') + (src ? ` ? ${src}` : '')",
        "meta.textContent = ` ${MID_DOT} ${biText(AT.obsUi.eventsCountZh(nEv), '')}` + (s.events_truncated ? biText(AT.obsUi.truncatedZh, '') : '') + (src ? ` ${MID_DOT} ${src}` : '')",
    ),
    (
        "hr.innerHTML = `<th class=\"idx\">#</th><th>${biHtml('??', 'Time')}</th><th>${biHtml('??', 'Event')}</th><th>${biHtml('???', 'Main task')}</th><th>${biHtml('???', 'Subtask')}</th><th>${biHtml('??', 'Status')}</th><th>${biHtml('??', 'Detail')}</th>`",
        "hr.innerHTML = `<th class=\"idx\">#</th><th>${biHtml(AT.kf.timeZh, 'Time')}</th><th>${biHtml(AT.kf.eventZh, 'Event')}</th><th>${biHtml(AT.kf.mainTaskZh, 'Main task')}</th><th>${biHtml(AT.kf.subtaskZh, 'Subtask')}</th><th>${biHtml(AT.kf.statusZh, 'Status')}</th><th>${biHtml(AT.detailKeys.rawJsonZh, 'Detail')}</th>`",
    ),
    (
        "innerHTML = '<p class=\"el-obs-hint\">????</p>'",
        "innerHTML = `<p class=\"el-obs-hint\">${biText(AT.obsUi.loadingZh, 'Loading')}</p>`",
    ),
    (
        "innerHTML = '<tr><td colspan=\"8\" class=\"el-obs-empty\">????</td></tr>'",
        "innerHTML = `<tr><td colspan=\"8\" class=\"el-obs-empty\">${biText(AT.obsUi.loadingZh, 'Loading')}</td></tr>`",
    ),
    (
        "innerHTML = '<tr><td colspan=\"7\" class=\"el-obs-empty\">????</td></tr>'",
        "innerHTML = `<tr><td colspan=\"7\" class=\"el-obs-empty\">${biText(AT.obsUi.loadingZh, 'Loading')}</td></tr>`",
    ),
    ("SQLite ????:", "SQLite 加载失败:"),
    (
        "innerHTML = '<p class=\"el-obs-hint\">?? config.yaml ?? observability.enabled ??? SQLite ??</p>'",
        "innerHTML = `<p class=\"el-obs-hint\">${biText(AT.obsUi.obsConfigHintZh, '')}</p>`",
    ),
    ("SQLite ???????:", "SQLite 工具页加载失败:"),
    (
        "innerHTML = '<p class=\"el-obs-hint\">??? observability.enabled</p>'",
        "innerHTML = `<p class=\"el-obs-hint\">${biText(AT.obsUi.needObsZh, '')}</p>`",
    ),
]

for a, b in repls:
    if a not in s:
        print("MISSING:", a[:70])
    else:
        s = s.replace(a, b, 1)

# models page fail string (second occurrence of similar pattern)
if "SQLite 工具页加载失败:" in s:
    s = s.replace("SQLite ???????:", "SQLite 模型页加载失败:", 1)

# no-data rows (after loading placeholders)
for col in ("8", "7"):
    old = f"innerHTML = `<tr><td colspan=\"{col}\" class=\"el-obs-empty\">${{biText(AT.obsUi.loadingZh, 'Loading')}}</td></tr>`"
    # replace 2nd occurrence with noData
    idx = s.find(old)
    if idx >= 0:
        idx2 = s.find(old, idx + 1)
        if idx2 >= 0:
            new = f"innerHTML = `<tr><td colspan=\"{col}\" class=\"el-obs-empty\">${{biText(AT.obsUi.noDataZh, '')}}</td></tr>`"
            s = s[:idx2] + new + s[idx2 + len(old):]

p.write_text(s, encoding="utf-8", newline="\n")
print("patched", p)
