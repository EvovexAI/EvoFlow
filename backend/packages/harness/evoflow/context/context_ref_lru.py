"""Per-thread LRU registry for persisted tool-result file references."""

from __future__ import annotations

import threading
from collections import OrderedDict

from evoflow.config.tool_results_config import get_tool_results_config

_lock = threading.Lock()
_refs: dict[str, OrderedDict[str, int]] = {}


def register_ref(thread_id: str, path: str, char_estimate: int) -> None:
    tid = str(thread_id or "").strip()
    p = str(path or "").strip()
    if not tid or not p:
        return
    cfg = get_tool_results_config()
    if not cfg.ref_lru_enabled:
        return
    with _lock:
        od = _refs.setdefault(tid, OrderedDict())
        od[p] = max(1, int(char_estimate))
        od.move_to_end(p)
        _evict_locked(tid, od)


def _evict_locked(thread_id: str, od: OrderedDict[str, int]) -> None:
    cfg = get_tool_results_config()
    budget = cfg.ref_lru_max_chars
    total = sum(od.values())
    while od and total > budget:
        _path, size = od.popitem(last=False)
        total -= size


def list_refs(thread_id: str) -> list[str]:
    tid = str(thread_id or "").strip()
    with _lock:
        od = _refs.get(tid)
        if not od:
            return []
        return list(od.keys())


def refs_footer(thread_id: str) -> str:
    paths = list_refs(thread_id)
    if not paths:
        return ""
    lines = ["<context_refs>", "Recent large tool outputs on disk (use read_file with offset/limit):", ""]
    for p in paths[-8:]:
        lines.append(f"- {p}")
    lines.append("</context_refs>")
    return "\n".join(lines)
