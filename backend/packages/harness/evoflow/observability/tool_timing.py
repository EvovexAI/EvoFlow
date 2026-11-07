"""Cross-layer queue-wait reporting for tool observability.

``tool_error_handling_middleware`` measures handler wall time, which includes
time a tool spent waiting on internal execution channels — e.g. the bash
per-thread exec lock plus the process-wide concurrency semaphore (2026-11-07
prod data: a queued `git show` recorded 237s while actually running 0.3s).
Tools report that wait here, keyed by ``tool_call_id``; the middleware pops it
after the handler returns and stores it as ``queue_wait_ms`` next to
``duration_ms`` (which stays total wall time).

The registry is process-local and bounded: entries are consumed by the
middleware in practice; the clear-guard only bounds a pathological leak.
"""

from __future__ import annotations

import threading

_QUEUE_WAITS: dict[str, float] = {}
_QUEUE_WAITS_LOCK = threading.Lock()
_QUEUE_WAITS_MAX = 4096


def note_tool_queue_wait(tool_call_id: str, wait_ms: float) -> None:
    """Record how long this tool call waited on internal execution channels."""
    key = str(tool_call_id or "").strip()
    if not key or wait_ms <= 0:
        return
    with _QUEUE_WAITS_LOCK:
        if len(_QUEUE_WAITS) >= _QUEUE_WAITS_MAX:
            _QUEUE_WAITS.clear()
        _QUEUE_WAITS[key] = float(wait_ms)


def pop_tool_queue_wait(tool_call_id: str) -> float | None:
    """Consume the recorded wait for *tool_call_id* (``None`` if never set)."""
    key = str(tool_call_id or "").strip()
    if not key:
        return None
    with _QUEUE_WAITS_LOCK:
        return _QUEUE_WAITS.pop(key, None)
