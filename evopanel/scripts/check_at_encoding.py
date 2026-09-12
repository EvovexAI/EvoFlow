# -*- coding: utf-8 -*-
from pathlib import Path
import re
p = Path(__file__).resolve().parents[1] / "src" / "pages" / "agent-trace.js"
s = p.read_text(encoding="utf-8")
for pat in [
    r"railWithDedupedPhase\('([^']+)'",
    r"k: '([^']{1,20})', v: tools",
    r"return body \? `([^`]{0,30})",
]:
    for m in re.finditer(pat, s):
        print(repr(m.group(1)), [hex(ord(c)) for c in m.group(1)[:8]])
        break
