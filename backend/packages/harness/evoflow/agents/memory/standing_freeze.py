"""Session-scoped frozen standing memory for prefix-cache stability.

Standing MEMORY / USER / workspace_memory blocks are frozen per thread on first
use and only refreshed via ``invalidate_standing_memory`` (e.g. after compaction).
Query-keyed person/craft recall must not enter this freeze — it rides turn-tail.
"""

from __future__ import annotations

import threading
from typing import Callable

_lock = threading.Lock()
_standing_by_thread: dict[str, str] = {}


def get_frozen_standing_memory(thread_id: str, builder: Callable[[], str]) -> str:
    tid = str(thread_id or "").strip() or "_default"
    with _lock:
        hit = _standing_by_thread.get(tid)
        if hit is not None:
            return hit
    text = str(builder() or "").strip()
    with _lock:
        # Another caller may have won the race; prefer first freeze.
        existing = _standing_by_thread.get(tid)
        if existing is not None:
            return existing
        _standing_by_thread[tid] = text
        return text


def invalidate_standing_memory(thread_id: str | None = None) -> None:
    """Drop freeze for one thread, or all threads when ``thread_id`` is empty."""
    tid = str(thread_id or "").strip()
    with _lock:
        if not tid:
            _standing_by_thread.clear()
            return
        _standing_by_thread.pop(tid, None)


def peek_standing_memory(thread_id: str) -> str | None:
    tid = str(thread_id or "").strip() or "_default"
    with _lock:
        return _standing_by_thread.get(tid)
