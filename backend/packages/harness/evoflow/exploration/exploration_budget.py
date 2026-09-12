"""Per-thread exploration attempt tracking and low-signal detection."""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field

from evoflow.exploration.task_router import looks_like_filename_query

_lock = threading.Lock()
_store: dict[str, list[_Attempt]] = {}
_last_human_turn_fp: dict[str, str] = {}

_MAX_ATTEMPTS_STORED = 32
_SEARCH_CODE_INDEX_BUDGET = 3
_TERMINAL_RECURSE_BUDGET = 1

_GENERIC_SYMBOL_NOISE = frozenset(
    {
        "agent_client",
        "agent_dir",
        "agent_exists",
        "agent_doc_to_parts",
        "agent_parts_to_doc",
        "agent_memory_file",
        "agent_id_from_session_key",
    }
)


@dataclass
class _Attempt:
    tool_name: str
    query: str
    outcome: str
    root: str = ""
    at: float = field(default_factory=time.time)


def _thread_key(thread_id: str) -> str:
    return str(thread_id or "").strip()


def _normalize_root(root: str | None) -> str:
    rel = str(root or ".").strip().replace("\\", "/") or "."
    while rel.startswith("./"):
        rel = rel[2:]
    return rel.rstrip("/") or "."


def _find_sig(pattern: str, root: str) -> str:
    pat = str(pattern or "").strip().casefold()
    r = _normalize_root(root)
    return f"{r}\0{pat}"


def _find_output_has_hits(output: str) -> bool:
    text = str(output or "").strip()
    if not text or text.startswith("Error:"):
        return False
    if text.startswith("No files matching"):
        return False
    return text.startswith("Found ") and "file(s) matching" in text


def _normalize_query(tool_input: dict) -> str:
    parts: list[str] = []
    for key in ("query", "pattern", "command", "q"):
        val = tool_input.get(key)
        if val is not None and str(val).strip():
            parts.append(str(val).strip())
    return " ".join(parts)[:240]


def _resolve_worker_task(tool_input: dict) -> tuple[str, dict]:
    """Map worker batch to budget tool name + normalized input."""
    inp = tool_input if isinstance(tool_input, dict) else {}
    tasks = inp.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        return "worker", inp
    first = tasks[0] if isinstance(tasks[0], dict) else {}
    action = str(first.get("action") or "").strip().lower()
    if action == "locate":
        return "find", {
            "pattern": str(first.get("query") or "").strip(),
            "root": str(first.get("path") or ".").strip() or ".",
        }
    if action == "search":
        return "search_code_index", {"query": str(first.get("query") or "").strip()}
    return "worker", inp


def score_search_output(output: str, query: str) -> str:
    """Return outcome label: ok | low_signal | error."""
    text = str(output or "").strip()
    q = str(query or "").strip()
    if not text or text.startswith("Error:"):
        return "error"
    if q.lower().startswith("path:"):
        if "No index hits" in text:
            return "low_signal"
        return "ok"
    if looks_like_filename_query(q):
        base = q.replace("\\", "/").split("/")[-1].casefold()
        if base and base not in text.casefold():
            return "low_signal"
    if "Symbols:" in text:
        sym_block = text.split("Symbols:", 1)[1].split("\n\n", 1)[0]
        names = re.findall(r"@\s+[^:]+:\d+", sym_block)
        if names and all(any(noise in line for noise in _GENERIC_SYMBOL_NOISE) for line in names[:4]):
            if q.casefold() not in text.casefold():
                return "low_signal"
    if "No index hits" in text and q and q.casefold() not in text.casefold():
        return "low_signal"
    return "ok"


def record_tool_attempt(
    thread_id: str,
    *,
    tool_name: str,
    tool_input: dict | None = None,
    output_text: str = "",
) -> None:
    tid = _thread_key(thread_id)
    if not tid:
        return
    name = str(tool_name or "").strip().lower()
    if name == "find_file":
        name = "find"
    if name not in {"search_code_index", "worker", "terminal", "rg", "find"}:
        return
    inp = tool_input if isinstance(tool_input, dict) else {}
    root = ""
    if name == "worker":
        name, inp = _resolve_worker_task(inp)
    query = _normalize_query(inp)
    if name == "find":
        root = _normalize_root(inp.get("root"))
        if not _find_output_has_hits(output_text):
            return
    outcome = "ok"
    if name in {"search_code_index", "worker", "rg"}:
        outcome = score_search_output(output_text, query)
    elif name == "terminal" and _is_unbounded_recurse_command(query):
        outcome = "blocked"
    with _lock:
        rows = _store.setdefault(tid, [])
        rows.append(_Attempt(tool_name=name, query=query, outcome=outcome, root=root))
        if len(rows) > _MAX_ATTEMPTS_STORED:
            del rows[: len(rows) - _MAX_ATTEMPTS_STORED]


def _recent_attempts(thread_id: str, tool_name: str) -> list[_Attempt]:
    tid = _thread_key(thread_id)
    name = str(tool_name or "").strip().lower()
    if name == "find_file":
        name = "find"
    with _lock:
        return [a for a in _store.get(tid, []) if a.tool_name == name]


def check_tool_budget(thread_id: str, tool_name: str, tool_input: dict | None = None) -> str | None:
    """Return error string when budget exceeded, else None."""
    tid = _thread_key(thread_id)
    if not tid:
        return None
    name = str(tool_name or "").strip().lower()
    if name == "find_file":
        name = "find"
    inp = tool_input if isinstance(tool_input, dict) else {}
    query = _normalize_query(inp)

    if name == "search_code_index" and looks_like_filename_query(query) and not query.startswith("path:"):
        from evoflow.exploration.task_router import suggest_find_file_message

        return suggest_find_file_message(query)

    if name == "search_code_index":
        attempts = _recent_attempts(tid, name)
        low = [a for a in attempts if a.outcome == "low_signal"]
        if len(attempts) >= _SEARCH_CODE_INDEX_BUDGET and len(low) >= _SEARCH_CODE_INDEX_BUDGET:
            return (
                "Error: search_code_index produced low-signal results repeatedly. "
                "Switch strategy: find(pattern, root='...'), worker(tasks=[{'action':'locate',...}]), "
                "read on a known path, or curl the relevant API for data bugs."
            )

    if name == "terminal" and _is_unbounded_recurse_command(query):
        recent = _recent_attempts(tid, "terminal")
        blocked = [a for a in recent if a.outcome == "blocked"]
        if blocked:
            return (
                "Error: Unbounded filesystem scan blocked (already attempted). "
                "Use find(pattern, root='<subdir>') or rg with a scoped path."
            )

    if name == "find":
        pattern = str(inp.get("pattern") or query or "").strip()
        root = _normalize_root(inp.get("root"))
        sig = _find_sig(pattern, root)
        attempts = _recent_attempts(tid, name)
        if any(_find_sig(a.query, a.root) == sig for a in attempts):
            return (
                f"Error: find(pattern={pattern!r}, root={root!r}) was already tried this turn. "
                "Read paths from the prior listing, use find with a narrower root, "
                "or batch different globs via worker(tasks=[{'action':'locate','query':'...','path':'...'}, ...])."
            )

    return None


def maybe_reset_exploration_budget_on_turn(thread_id: str, human_turn_fp: str) -> None:
    """Clear per-turn exploration counters when the user sends a new message."""
    tid = _thread_key(thread_id)
    fp = str(human_turn_fp or "").strip()
    if not tid or not fp:
        return
    with _lock:
        prev = _last_human_turn_fp.get(tid)
        if prev == fp:
            return
        _last_human_turn_fp[tid] = fp
        _store.pop(tid, None)


def format_exploration_hint(thread_id: str) -> str:
    tid = _thread_key(thread_id)
    if not tid:
        return ""
    with _lock:
        rows = list(_store.get(tid, []))
    if not rows:
        return ""
    low = sum(1 for r in rows if r.outcome == "low_signal")
    if low < 2:
        return ""
    return (
        "<exploration_hint>\n"
        "Recent tool attempts had low signal. Do not repeat similar search_code_index queries. "
        "Switch tool class: find / rg / read_file / API curl.\n"
        "</exploration_hint>"
    )


def clear_exploration_budget(thread_id: str) -> None:
    tid = _thread_key(thread_id)
    if not tid:
        return
    with _lock:
        _store.pop(tid, None)
        _last_human_turn_fp.pop(tid, None)


def is_unbounded_recurse_command(command: str) -> bool:
    """Public helper for terminal guard."""
    return _is_unbounded_recurse_command(command)


def _is_unbounded_recurse_command(command: str) -> bool:
    cmd = str(command or "").strip()
    if not cmd:
        return False
    if re.search(r"\bfind\s+\.", cmd) and "maxdepth" not in cmd.lower():
        return True
    # Evaluate each statement separately so e.g. ``Remove-Item -Recurse`` in one
    # segment does not flag a non-recursive ``Get-ChildItem`` in another.
    for segment in re.split(r";", cmd):
        seg = segment.strip()
        if not seg:
            continue
        if re.search(r"Get-ChildItem\b", seg, re.IGNORECASE) and re.search(r"-Recurse\b", seg, re.IGNORECASE):
            if not re.search(r"-Path\s+\S", seg, re.IGNORECASE):
                return True
        if re.search(r"Get-ChildItem\s+-Recurse\b", seg, re.IGNORECASE) and "-Path" not in seg:
            return True
    return False
