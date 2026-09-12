"""Heuristic task classification and tool-routing hints."""

from __future__ import annotations

import re

TaskType = str

TASK_LOCATE_FILE = "locate_file"
TASK_UNDERSTAND_CODE = "understand_code"
TASK_DATA_BUG = "data_bug"
TASK_IMPLEMENT = "implement"
TASK_RUNTIME = "runtime"
TASK_GENERAL = "general"

_FILENAME_RE = re.compile(
    r"(?:^|[\s/\\])([A-Za-z0-9_.-]+\.(?:html?|tsx?|jsx?|py|js|css|md|yaml|yml|json|vue|rs|go|java|kt|sql|sh|ps1))\b",
    re.IGNORECASE,
)
_GLOBISH_RE = re.compile(r"[*?[\]]")
_PATHISH_RE = re.compile(r"(?:^|[\s/\\])(?:src|backend|frontend|lib|app|packages)/", re.IGNORECASE)

_DATA_BUG_RE = re.compile(
    r"(表格|显示|展示|数据.{0,6}问题|数据.{0,6}不对|数据.{0,6}错|错位|缺字段|空白|为空|"
    r"table|display|render|ui.{0,8}bug|wrong data|missing data|empty row|misalign)",
    re.IGNORECASE,
)
_RUNTIME_RE = re.compile(
    r"(卡住|hang|timeout|超时|崩溃|crash|gateway|进程|port|日志|log|502|503|504|"
    r"not responding|blocked|freeze)",
    re.IGNORECASE,
)
_IMPLEMENT_RE = re.compile(
    r"(实现|修复|改掉|改一下|改个|调整|优化|加上|删除|重构|合并|布局|样式|改成|改为|"
    r"implement|fix|add feature|patch|refactor|layout|css|ui tweak|merge|tweak)",
    re.IGNORECASE,
)
_UI_EDIT_RE = re.compile(
    r"(布局|样式|一行|合并|对齐|间距|flex|grid|filter-bar|筛选|顶栏|sidebar|header)",
    re.IGNORECASE,
)
_LOCATE_RE = re.compile(
    r"(在哪|哪个文件|文件在哪|find file|where is|locate|路径是)",
    re.IGNORECASE,
)


def looks_like_filename_query(query: str) -> bool:
    raw = str(query or "").strip()
    if not raw or raw.startswith("path:"):
        return False
    # "queries.py _summarize_response" / "obs-api.ts fetchObsModels" → symbol search, not locate-file.
    if re.search(r"\s", raw):
        tokens = [t for t in re.split(r"\s+", raw) if t.strip()]
        symbolish = [
            t
            for t in tokens
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{2,}", t) or "|" in t
        ]
        if len(symbolish) >= 1 and len(tokens) >= 2:
            return False
    if _GLOBISH_RE.search(raw):
        return True
    if _FILENAME_RE.search(raw):
        return True
    if "/" in raw or "\\" in raw:
        tail = raw.replace("\\", "/").split("/")[-1]
        if "." in tail and len(tail) <= 120:
            return True
    return False


def suggest_find_file_message(query: str) -> str:
    q = str(query or "").strip()
    pattern = q
    if "." in q and not _GLOBISH_RE.search(q):
        pattern = f"*{q.split('/')[-1].split(chr(92))[-1]}*"
    return (
        f"Error: Query {q!r} looks like a filename/path, not a symbol search. "
        f"Use find(pattern={pattern!r}, root='<known-subdir>') "
        f"or worker(tasks=[{{'action':'locate','query':{pattern!r},'path':'<subdir>'}}]). "
        "For symbols use path:dir/subdir Symbol|alias with search_code_index."
    )


def classify_task_type_heuristic(text: str) -> TaskType:
    """Lightweight first-turn classifier (no LLM)."""
    msg = str(text or "").strip()
    if not msg:
        return TASK_GENERAL
    if _RUNTIME_RE.search(msg):
        return TASK_RUNTIME
    # Edit/layout intent wins over bare filename mentions in the same message.
    if _IMPLEMENT_RE.search(msg) or _UI_EDIT_RE.search(msg):
        return TASK_IMPLEMENT
    if _DATA_BUG_RE.search(msg):
        return TASK_DATA_BUG
    if looks_like_filename_query(msg) or _LOCATE_RE.search(msg) or _PATHISH_RE.search(msg):
        return TASK_LOCATE_FILE
    if re.search(r"(怎么|如何|what does|how does|explain)", msg, re.IGNORECASE):
        return TASK_UNDERSTAND_CODE
    return TASK_GENERAL


def infer_task_type_label(task_type: str, *, zh: bool = True) -> str:
    labels = {
        TASK_LOCATE_FILE: ("定位文件", "locate file"),
        TASK_UNDERSTAND_CODE: ("理解代码", "understand code"),
        TASK_DATA_BUG: ("数据/展示问题", "data/display bug"),
        TASK_IMPLEMENT: ("实现/修复", "implement/fix"),
        TASK_RUNTIME: ("运行/环境问题", "runtime/environment"),
        TASK_GENERAL: ("一般任务", "general"),
    }
    pair = labels.get(str(task_type or "").strip(), labels[TASK_GENERAL])
    return pair[0] if zh else pair[1]
