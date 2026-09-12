# -*- coding: utf-8 -*-
from pathlib import Path

p = Path(__file__).resolve().parents[1] / "src" / "pages" / "agent-trace.js"
s = p.read_text(encoding="utf-8", errors="replace")
repls = [
    ("biHtml('?????', 'Observability')", "biHtml('\\u89c2\\u6d4b\\u4e0e\\u8c03\\u8bd5', 'Observability')"),
    ("biHtml('??????????', 'More DB views can go here')", "biHtml('\\u66f4\\u591a\\u6570\\u636e\\u8868\\u53ef\\u5728\\u6b64\\u6269\\u5c55', 'More DB views can go here')"),
    (
        '<span class="el-obs-menu-icon">??</span><span>${biText(\'??\', \'Overview\')}</span>',
        '<span class="el-obs-menu-icon">\U0001f4ca</span><span>${biText(\'\\u603b\\u89c8\', \'Overview\')}</span>',
    ),
    (
        '<span class="el-obs-menu-icon">???</span><span>${biText(\'??\', \'Tools\')}</span>',
        '<span class="el-obs-menu-icon">\U0001f6e0\ufe0f</span><span>${biText(\'\\u5de5\\u5177\', \'Tools\')}</span>',
    ),
    (
        '<span class="el-obs-menu-icon">??</span><span>${biText(\'??\', \'Models\')}</span>',
        '<span class="el-obs-menu-icon">\U0001f916</span><span>${biText(\'\\u6a21\\u578b\', \'Models\')}</span>',
    ),
    (
        '<span class="el-obs-menu-icon">??</span><span>${biText(\'??\', \'Sessions\')}</span>',
        '<span class="el-obs-menu-icon">\U0001f4ac</span><span>${biText(\'\\u4f1a\\u8bdd\', \'Sessions\')}</span>',
    ),
    ("${biText('??', 'Actions')}", "${biText('\\u64cd\\u4f5c', 'Actions')}"),
    ("${biText('????', 'Overview')}", "${biText('\\u603b\\u89c8\\u7edf\\u8ba1', 'Overview')}"),
    ("${biText('??????', 'Tool calls')}", "${biText('\\u5de5\\u5177\\u8c03\\u7528\\u7edf\\u8ba1', 'Tool calls')}"),
    ("${biText('????', 'Details')}", "${biText('\\u8c03\\u7528\\u8be6\\u60c5', 'Details')}"),
    ("${biText('??', 'Time')}", "${biText('\\u65f6\\u95f4', 'Time')}"),
    ("${biText('???', 'Tool')}", "${biText('\\u5de5\\u5177\\u540d', 'Tool')}"),
    ("${biText('??', 'Status')}", "${biText('\\u72b6\\u6001', 'Status')}"),
    ("${biText('??', 'Duration')}", "${biText('\\u8017\\u65f6', 'Duration')}"),
    ("${biText('??', 'Thread')}", "${biText('\\u4f1a\\u8bdd', 'Thread')}"),
    ("${biText('??', 'Error')}", "${biText('\\u62a5\\u9519', 'Error')}"),
    ("${biText('??', 'Detail')}", "${biText('\\u8be6\\u60c5', 'Detail')}"),
    ("${biText('??????', 'Model requests')}", "${biText('\\u6a21\\u578b\\u5382\\u5546\\u8bf7\\u6c42', 'Model requests')}"),
    ("${biText('??', 'Provider')}", "${biText('\\u5382\\u5546', 'Provider')}"),
    ("${biText('??', 'Model')}", "${biText('\\u6a21\\u578b', 'Model')}"),
    ("${biText('???', 'Request')}", "${biText('\\u8bf7\\u6c42\\u4f53', 'Request')}"),
    ("${biText('SQLite ?????', 'SQLite timeline')}", "${biText('SQLite \\u89c2\\u6d4b\\u65f6\\u5149\\u8f74', 'SQLite timeline')}"),
]
for a, b in repls:
    if a not in s:
        print("MISSING:", repr(a)[:100])
    else:
        s = s.replace(a, b)
p.write_text(s, encoding="utf-8", newline="\n")
print("patched", p)
