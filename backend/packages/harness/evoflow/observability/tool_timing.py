"""Cross-layer timing reporting for tool observability.

``tool_error_handling_middleware`` measures handler wall time, which includes
time a tool spent waiting on internal execution channels — e.g. the bash
per-thread exec lock plus the process-wide concurrency semaphore (2026-11-07
prod data: a queued `git show` recorded 237s while actually running 0.3s).

Tools report:

- ``queue_wait_ms`` — lock/semaphore wait before real work
- ``timing`` detail dict — path breakdown (warm/cold, dialect, exec_ms, …)

Both are keyed by ``tool_call_id``; the middleware pops them after the handler
returns and stores them next to ``duration_ms`` (which stays total wall time).

Diagnosis cheat-sheet for bash:

- ``queue_wait_ms`` large, ``timing.exec_ms`` small → execution channel queue
- ``path=cold`` / ``dialect=powershell`` + high exec → shell cold start
- ``path=warm`` + high exec → the command itself (or hung child)
- both small but UI slow → model/gateway round-trip, not shell
"""

from __future__ import annotations

import threading
from typing import Any

_QUEUE_WAITS: dict[str, float] = {}
_QUEUE_WAITS_LOCK = threading.Lock()
_QUEUE_WAITS_MAX = 4096

_EXEC_DETAILS: dict[str, dict[str, Any]] = {}
_EXEC_DETAILS_LOCK = threading.Lock()
_EXEC_DETAILS_MAX = 4096


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


def note_tool_exec_detail(tool_call_id: str, detail: dict[str, Any]) -> None:
    """Record structured execution timing (merged if called more than once)."""
    key = str(tool_call_id or "").strip()
    if not key or not isinstance(detail, dict) or not detail:
        return
    with _EXEC_DETAILS_LOCK:
        if len(_EXEC_DETAILS) >= _EXEC_DETAILS_MAX:
            _EXEC_DETAILS.clear()
        prev = _EXEC_DETAILS.get(key)
        if isinstance(prev, dict):
            merged = dict(prev)
            merged.update(detail)
            _EXEC_DETAILS[key] = merged
        else:
            _EXEC_DETAILS[key] = dict(detail)


def pop_tool_exec_detail(tool_call_id: str) -> dict[str, Any] | None:
    """Consume the recorded timing detail for *tool_call_id*."""
    key = str(tool_call_id or "").strip()
    if not key:
        return None
    with _EXEC_DETAILS_LOCK:
        return _EXEC_DETAILS.pop(key, None)
