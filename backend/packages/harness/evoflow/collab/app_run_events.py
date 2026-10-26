"""App-run write-path SSOT: main-task truth → ``evoflow_app_runs``.

Mutation paths (subtask rollup, DAG advance, requeue) must emit here.
GET ``_heal_run_invariant`` stays a safety net only — not the primary sync.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


_TERMINAL_NOTIFY_STATUSES = frozenset({"completed", "failed", "cancelled", "canceled"})

_TERMINAL_NOTIFY_TITLES = {
    "completed": "工作流完成",
    "failed": "工作流失败",
    "cancelled": "工作流已取消",
    "canceled": "工作流已取消",
}


def notify_workflow_terminal(
    *,
    app_id: str,
    run_id: str,
    app_name: str = "",
    status: str,
    summary: str = "",
    created_by: str | None = None,
) -> bool:
    """Persist a workflow terminal notification into the UI notification center.

    Lightweight D-2 (workflow-audit-roadmap): no new outbox table —
    ``evoflow_session_notifications`` already provides fingerprint dedup,
    read/clear semantics, unread counts and per-owner filtering. The
    ``session_key`` encodes ``app-run:{app_id}:{run_id}`` so the frontend can
    deep-link from the notification into the run history page; the run_id
    prefix in ``body`` keeps the fingerprint stable per run.
    """
    aid = str(app_id or "").strip()
    rid = str(run_id or "").strip()
    st = str(status or "").strip().lower()
    if not aid or not rid or st not in _TERMINAL_NOTIFY_STATUSES:
        return False
    try:
        from evoflow.persistence.session_notification_repositories import push_session_notification

        name = str(app_name or "").strip() or "工作流"
        body = f"[{rid}] {str(summary or '').strip() or st}"[:300]
        return bool(
            push_session_notification(
                session_key=f"app-run:{aid}:{rid}",
                session_title=name,
                kind="workflow_finished",
                title=f"{_TERMINAL_NOTIFY_TITLES.get(st, '工作流结束')}：{name}"[:120],
                outcome=st,
                body=body,
                created_by=str(created_by or "").strip() or None,
            )
        )
    except Exception:
        logger.debug("notify_workflow_terminal failed run=%s", rid, exc_info=True)
        return False


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
        if str(status).strip().lower() in _TERMINAL_NOTIFY_STATUSES:
            # Lightweight D-2: terminal state lands in the notification center
            # (deduped by fingerprint) so the result survives even with no page
            # open; IM push stays an optional fan-out on the automation config.
            notify_workflow_terminal(
                app_id=str(task.get("source_app_id") or "").strip(),
                run_id=str(task.get("source_run_id") or "").strip(),
                app_name=str(task.get("source_app_name") or "").strip(),
                status=str(status),
                summary=str(task.get("result_summary") or task.get("result_text") or task.get("error_text") or ""),
                created_by=str(task.get("principal_id") or "").strip() or None,
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
