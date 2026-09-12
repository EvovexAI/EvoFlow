"""Append-only per-chat-thread task + subtask lifecycle events (SQLite observability)."""

from __future__ import annotations

from typing import Any

from evoflow.timeutil import beijing_now_iso


def write_task_lifecycle_trace(
    *,
    thread_id: str | None,
    event: str,
    main_task_id: str | None = None,
    subtask_id: str | None = None,
    status: str | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    """Record one lifecycle row (best-effort)."""
    try:
        tid = (thread_id or "").strip() or None
        row: dict[str, Any] = {
            "ts": beijing_now_iso(),
            "schema": "evoflow.task_lifecycle.v1",
            "event": str(event or "").strip(),
        }
        if main_task_id:
            row["main_task_id"] = str(main_task_id).strip()
        if subtask_id:
            row["subtask_id"] = str(subtask_id).strip()
        if status is not None and str(status).strip():
            row["status"] = str(status).strip().lower()
        if detail:
            row["detail"] = detail
        try:
            from evoflow.observability.recorder import get_observability_recorder

            get_observability_recorder().record_task_lifecycle(
                thread_id=tid,
                occurred_at=str(row["ts"]),
                schema_version=str(row.get("schema") or ""),
                event=str(event or "").strip(),
                main_task_id=str(main_task_id).strip() if main_task_id else None,
                subtask_id=str(subtask_id).strip() if subtask_id else None,
                status=str(status).strip() if status is not None and str(status).strip() else None,
                detail=detail,
            )
        except Exception:
            pass
    except Exception:
        return
