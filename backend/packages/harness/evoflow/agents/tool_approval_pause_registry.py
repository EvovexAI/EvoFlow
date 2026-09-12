"""In-memory tool-approval pause flags (avoid SQLite polls while POST SSE is deferred)."""

from __future__ import annotations

import logging
import threading

logger = logging.getLogger(__name__)

_LOCK = threading.Lock()
_PAUSED_THREADS: set[str] = set()


def mark_tool_approval_pause(thread_id: str) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    with _LOCK:
        _PAUSED_THREADS.add(tid)
    logger.info("tool approval pause marked thread=%s paused_count=%s", tid, len(_PAUSED_THREADS))


def clear_tool_approval_pause(thread_id: str) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    with _LOCK:
        _PAUSED_THREADS.discard(tid)
    logger.info("tool approval pause cleared thread=%s paused_count=%s", tid, len(_PAUSED_THREADS))


def thread_in_tool_approval_pause(thread_id: str) -> bool:
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    with _LOCK:
        return tid in _PAUSED_THREADS


__all__ = [
    "clear_tool_approval_pause",
    "mark_tool_approval_pause",
    "thread_in_tool_approval_pause",
]
