"""Server-side task runtime health (live / interrupted / idle).

Source of truth: ``evoflow_chat_sessions.run_status`` (+ ``collab_task_id`` /
``thread_id``), **not** a frontend probe of ``/langgraph/active-sessions``.

``progress`` remains the board field on the collab task row; this module only
answers whether an in-flight lifecycle still has a live worker session.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_IN_FLIGHT = frozenset(
    {
        "executing",
        "running",
        "in_progress",
        "active",
        "waiting_dispatch",
        "planning",
        "planned",
        "awaiting_exec",
        "plan_ready",
        "queued",
    }
)

_IDLE_LIFECYCLE = frozenset(
    {
        "completed",
        "reviewed",
        "failed",
        "error",
        "timed_out",
        "cancelled",
        "canceled",
        "awaiting_close",
        "waiting_user",
        "req_confirm",
        "pending",
        "idle",
        "blocked",
        "paused",
        "inbox",
    }
)


def _lifecycle_in_flight(status: Any) -> bool:
    st = str(status or "").strip().lower()
    if not st:
        return False
    if st in _IDLE_LIFECYCLE:
        return False
    return st in _IN_FLIGHT


def _task_id_from_proactive_session_key(session_key: str) -> str | None:
    """Parse ``proactive:{code}:task:{task_id}`` — heals rows that never stamped collab_task_id."""
    sk = str(session_key or "").strip()
    if not sk.startswith("proactive:"):
        return None
    parts = sk.split(":")
    # proactive / code / task / task_id
    if len(parts) < 4 or parts[2] != "task":
        return None
    tid = str(parts[3] or "").strip()
    return tid or None


def load_active_run_index() -> dict[str, set[str]]:
    """Maps for join: ``by_task_id`` / ``by_thread_id`` of sessions with run_status running|pending."""
    by_task: set[str] = set()
    by_thread: set[str] = set()
    try:
        from evoflow.persistence.session_run_state import list_all_active_sessions

        for row in list_all_active_sessions(limit=2000):
            cid = str(row.get("collab_task_id") or "").strip()
            tid = str(row.get("thread_id") or "").strip()
            if not cid:
                # Legacy proactive task sessions only had related_task_id in context_json.
                cid = _task_id_from_proactive_session_key(str(row.get("session_key") or "")) or ""
            if cid:
                by_task.add(cid)
            if tid:
                by_thread.add(tid)
    except Exception:
        logger.debug("task_runtime_health: load active sessions failed", exc_info=True)
    return {"by_task_id": by_task, "by_thread_id": by_thread}


def resolve_task_runtime_health(
    task: dict[str, Any] | None,
    *,
    active_index: dict[str, set[str]] | None = None,
) -> str:
    """Return ``live`` | ``interrupted`` | ``idle``.

    - Terminal / waiting-human lifecycle → ``idle``
    - In-flight + matching active session → ``live``
    - In-flight + no active session → ``interrupted``
    """
    if not task:
        return "idle"
    st = str(task.get("status") or "").strip().lower()
    if not _lifecycle_in_flight(st):
        return "idle"

    index = active_index if active_index is not None else load_active_run_index()
    by_task = index.get("by_task_id") or set()
    by_thread = index.get("by_thread_id") or set()

    task_id = str(task.get("id") or task.get("task_id") or "").strip()
    thread_id = str(
        task.get("thread_id")
        or task.get("current_execution_thread_id")
        or task.get("currentExecutionThreadId")
        or ""
    ).strip()

    if task_id and task_id in by_task:
        return "live"
    if thread_id and thread_id in by_thread:
        return "live"
    return "interrupted"


def enrich_tasks_runtime_health(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Stamp ``runtime_health`` (+ optional ``run_alive``) on each task dict in place."""
    if not tasks:
        return tasks
    # Only pay for the SQLite scan when at least one row looks in-flight.
    need = any(_lifecycle_in_flight(t.get("status")) for t in tasks if isinstance(t, dict))
    index = load_active_run_index() if need else {"by_task_id": set(), "by_thread_id": set()}
    for t in tasks:
        if not isinstance(t, dict):
            continue
        health = resolve_task_runtime_health(t, active_index=index)
        t["runtime_health"] = health
        t["run_alive"] = health == "live"
    return tasks


__all__ = [
    "enrich_tasks_runtime_health",
    "load_active_run_index",
    "resolve_task_runtime_health",
]
