"""Canonical boundaries and examples for search_code_index vs rg vs find.

Single source of truth — imported by lead-agent prompts and referenced in tool docstrings.
"""

from __future__ import annotations

import re

from evoflow.tools.arg_coerce import parse_search_path_prefix, split_pipe_terms

# Phrases tests assert appear in prompts / docstrings (keep stable).
SEARCH_MATRIX_MARKER_EN = "<search_tool_matrix>"
SEARCH_MATRIX_MARKER_ZH = "<search_tool_matrix>"

# --- Decision table (EN) -------------------------------------------------------

SEARCH_TOOL_ROWS_EN: list[tuple[str, str, str, str]] = [
    (
        "Find file by name",
        "find / worker locate",
        'find(pattern="*agent-trace-model-response*", root="evopanel/src/pages")',
        "search_code_index with *.js filename",
    ),
    (
        "Find symbol / class / API",
        "search_code_index / worker search",
        'query="path:evopanel/src/pages renderModelResponseTypeCell|summarizeModelResponse"',
        'rg with pipe synonyms (| = regex OR, may timeout)',
    ),
    (
        "Scoped symbol in subdir",
        "search_code_index",
        'query="path:backend/packages/harness/evoflow/observability list_model_invocations"',
        "unscoped NL sentence or whole-repo rg",
    ),
    (
        "Literal / log / error string",
        "rg",
        'pattern="Error: rg timed out", path="backend", glob="*.log"',
        "search_code_index for exact log line",
    ),
    (
        "Regex in known file",
        "rg",
        'pattern="def fetch_tools_summary", path="backend/.../summaries.py"',
        "pipe keyword list like foo|bar|kind",
    ),
    (
        "UI label / mixed CN+EN synonyms",
        "search_code_index",
        'query="path:evopanel/src/pages 回复类型|response_summary|kind_label"',
        'rg pattern="回复类型|kind" (kind matches everywhere)',
    ),
    (
        "After index miss",
        "rg then read",
        'rg(pattern="response_summary", path="evopanel/src/pages", glob="*.js")',
        "repeat same index query or broader rg on .",
    ),
    (
        "Call/dependency chain",
        "trace_call_chain",
        'trace_call_chain(symbol="derive_session_mode", direction="callers", max_depth=3)',
        "manual rg across dozens of files for impact analysis",
    ),
]

# --- Decision table (ZH) -------------------------------------------------------

SEARCH_TOOL_ROWS_ZH: list[tuple[str, str, str, str]] = [
    (
        "按文件名定位",
        "find / worker locate",
        'find(pattern="*agent-trace-model-response*", root="evopanel/src/pages")',
        "用 search_code_index 搜 *.js 文件名",
    ),
    (
        "符号 / 类 / API",
        "search_code_index / worker search",
        'query="path:evopanel/src/pages renderModelResponseTypeCell|summarizeModelResponse"',
        "rg 里用 pipe 同义词（| 是正则 OR，易超时）",
    ),
    (
        "子目录内符号",
        "search_code_index",
        'query="path:backend/packages/harness/evoflow/observability list_model_invocations"',
        "无 path: 的自然语言整句或全库 rg",
    ),
    (
        "字面量 / 日志 / 报错",
        "rg",
        'pattern="Error: rg timed out", path="backend", glob="*.log"',
        "用 search_code_index 搜完整日志行",
    ),
    (
        "已知文件内正则",
        "rg",
        'pattern="def fetch_tools_summary", path="backend/.../summaries.py"',
        'pipe 关键词列表如 foo|bar|kind',
    ),
    (
        "界面文案 / 中英同义词",
        "search_code_index",
        'query="path:evopanel/src/pages 回复类型|response_summary|kind_label"',
        'rg pattern="回复类型|kind"（kind 几乎处处匹配）',
    ),
    (
        "index 无命中后",
        "rg 再 read",
        'rg(pattern="response_summary", path="evopanel/src/pages", glob="*.js")',
        "重复同一 index 查询或在 . 上大范围 rg",
    ),
    (
        "调用/依赖链追踪",
        "trace_call_chain",
        'trace_call_chain(symbol="derive_session_mode", direction="callers", max_depth=3)',
        "手动 rg 遍历数十个文件做影响面分析",
    ),
]

def _format_table(rows: list[tuple[str, str, str, str]], *, lang: str) -> str:
    hdr = (
        "| Intent | Tool | Good example | Avoid |\n"
        if lang == "en"
        else "| 意图 | 工具 | 正确示例 | 避免 |\n"
    )
    lines = [hdr]
    for intent, tool, good, avoid in rows:
        lines.append(f"| {intent} | {tool} | {good} | {avoid} |")
    return "\n".join(lines)


def format_search_tool_matrix_en() -> str:
    body = _format_table(SEARCH_TOOL_ROWS_EN, lang="en")
    rules = """
**Pipe `|` semantics (critical)**
- `search_code_index`: `foo|bar` = **synonym OR** (FTS + symbols)
- `rg`: `foo|bar` = **regex alternation** — poison terms (`kind`, `type`) match everywhere → 45s timeout; pipe keyword lists auto-redirect to index or `rg -F`

**Path scope**
- Index: `path:evopanel/src/pages Symbol|alias` — always scope before searching whole repo
- rg: `path="evopanel/src/pages"`, optional `glob="*.js"`

**Workflow**
1. Filename? → `find`
2. Symbol/API? → `search_code_index` with `path:` + `|`
3. Need line context / literal? → narrow `rg` + `read`
4. Never: `rg` on `evopanel/src/pages` with `foo|bar|kind`"""
    return f"{SEARCH_MATRIX_MARKER_EN}\n{body.strip()}\n{rules.strip()}\n{SEARCH_MATRIX_MARKER_EN}"


def format_search_tool_matrix_zh() -> str:
    body = _format_table(SEARCH_TOOL_ROWS_ZH, lang="zh")
    rules = """
**Pipe `|` 语义（关键）**
- `search_code_index`：`foo|bar` = **同义词 OR**（FTS + 符号表）
- `rg`：`foo|bar` = **正则 OR** — 泛词（`kind`、`type`）几乎处处匹配 → 45s 超时；pipe 关键词会自动重定向 index 或 `rg -F`

**路径限定**
- Index：`path:evopanel/src/pages Symbol|alias` — 先限定目录再搜
- rg：`path="evopanel/src/pages"`，可加 `glob="*.js"`

**推荐流程**
1. 文件名？→ `find`
2. 符号/API？→ `search_code_index` + `path:` + `|`
3. 要行上下文/字面量？→ 窄范围 `rg` + `read`
4. 禁止：在 `evopanel/src/pages` 上对 `foo|bar|kind` 跑 rg"""
    return f"{SEARCH_MATRIX_MARKER_ZH}\n{body.strip()}\n{rules.strip()}\n{SEARCH_MATRIX_MARKER_ZH}"


def docstring_examples_search_code_index() -> str:
    return """
**Examples**
- Symbol: ``query="fetch_tools_summary"`` or ``query="WorkspaceMemoryUpdater"``
- Scoped synonyms: ``query="path:evopanel/src/pages renderModelResponseTypeCell|summarizeModelResponse|response_summary"``
- CN+EN labels: ``query="path:evopanel/src/pages 回复类型|response_summary|kind_label"``
- Anti-pattern: ``query="agent-trace-obs-sqlite.js"`` → use ``find(pattern="*agent-trace-obs-sqlite*")`` instead
"""


def docstring_examples_rg() -> str:
    return """
**Examples**
- Literal in file: ``pattern="response_summary"``, ``path="evopanel/src/pages/agent-trace-obs-sqlite.js"``
- Def line: ``pattern="def list_model_invocations"``, ``path="backend/packages/harness/evoflow/observability"``, ``glob="*.py"``
- Anti-pattern: ``pattern="renderModelResponseTypeCell|summarizeModelResponse"`` → use ``search_code_index`` (pipe = synonyms there)
- Anti-pattern: ``pattern="回复类型|kind"`` on a directory → ``kind`` matches everywhere; use index with ``path:`` scope
"""


def classify_search_intent(text: str) -> str:
    """Heuristic intent for tests and runtime hints: filename | symbol | literal | ambiguous."""
    raw = str(text or "").strip()
    if not raw:
        return "ambiguous"
    _prefix, body = parse_search_path_prefix(raw)
    probe = body or raw
    if re.search(r"^(def |class |Error:|TODO)", probe):
        return "literal"
    if re.search(r"[*?]", probe) or re.search(r"\.(?:html|tsx|jsx|js|ts|py|md|json|yaml)\b", probe, re.I):
        return "filename"
    if "|" in probe and len(split_pipe_terms(probe)) >= 2:
        return "symbol"
    if re.search(r"\s", probe) and len(probe.split()) >= 2:
        return "symbol"
    if re.fullmatch(r"[A-Za-z_][\w]*", probe) and (probe[0].isupper() or "_" in probe):
        return "symbol"
    return "ambiguous"


def suggest_tool_for_intent(intent: str) -> str:
    return {
        "filename": "find",
        "symbol": "search_code_index",
        "literal": "rg",
    }.get(intent, "search_code_index")


def expected_tool_for_query(query: str) -> str:
    """Primary tool recommendation for boundary tests."""
    intent = classify_search_intent(query)
    return suggest_tool_for_intent(intent)
