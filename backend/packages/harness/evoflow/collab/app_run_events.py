"""App-run write-path SSOT: main-task truth → ``evoflow_app_runs``.

Mutation paths (subtask rollup, DAG advance, requeue) must emit here.
GET ``_heal_run_invariant`` stays a safety net only — not the primary sync.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def emit_app_run_from_main_task(
    task: dict[str, Any] | None,
    *,
    reason: str = "",
) -> str | None:
    """Push main-task status/progress onto the linked app run.

    Returns effective run status, or ``None`` when not app-sourced / no run row.
    """
    from evoflow.collab.app_runner import push_app_run_from_main_task

    if not isinstance(task, dict):
        return None
    mid = str(task.get("id") or "").strip()
    why = str(reason or "").strip() or "unspecified"
    try:
        status = push_app_run_from_main_task(task)
    except Exception:
        logger.debug(
            "app_run_events.emit failed task_id=%s reason=%s",
            mid,
            why,
            exc_info=True,
        )
        return None
    if status is not None:
        logger.debug(
            "app_run_events.emit task_id=%s reason=%s run_status=%s progress=%s",
            mid,
            why,
            status,
            task.get("progress"),
        )
    return status


def emit_app_run_for_task_id(task_id: str, *, reason: str = "") -> str | None:
    """Load main task then emit; no-op when missing / not app-sourced."""
    from evoflow.collab.storage import find_main_task, get_project_storage

    tid = str(task_id or "").strip()
    if not tid:
        return None
    row = find_main_task(get_project_storage(), tid)
    if not row:
        return None
    _proj, task = row
    return emit_app_run_from_main_task(task if isinstance(task, dict) else None, reason=reason)


__all__ = ["emit_app_run_for_task_id", "emit_app_run_from_main_task"]
