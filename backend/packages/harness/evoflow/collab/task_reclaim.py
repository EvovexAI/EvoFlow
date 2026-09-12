"""Auto-reclaim zombie board tasks: stuck executing@100% and stale awaiting_close.

P2 state-machine hygiene — separate from noise cleanup (eval/meeting/receipt wrappers).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

logger = logging.getLogger(__name__)

_EXECUTING_LIKE = frozenset(
    {"executing", "in_progress", "running", "active", "waiting_dispatch"}
)
# Child must be fully closed — awaiting_close on a child means that subtree is still open.
_CHILD_FULLY_CLOSED = frozenset(
    {"completed", "reviewed", "failed", "error", "cancelled", "canceled", "deleted"}
)


def _parse_iso(ts: str) -> datetime | None:
    s = str(ts or "").strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt
    except Exception:
        return None


def _is_stale(task: dict[str, Any], *, days: int, now: datetime) -> bool:
    updated = _parse_iso(str(task.get("updated_at") or task.get("created_at") or ""))
    if updated is None:
        return False
    return (now - updated) >= timedelta(days=max(1, int(days)))


def _progress(task: dict[str, Any]) -> int:
    try:
        return int(task.get("progress") or 0)
    except (TypeError, ValueError):
        return 0


def _children_all_fully_closed(parent_task_id: str) -> dict[str, Any]:
    """Direct children; all_done when every child is fully closed (or no children)."""
    from evoflow.collab.upstream_receipt import list_child_task_rows

    rows = list_child_task_rows(parent_task_id)
    open_rows: list[dict[str, str]] = []
    for t in rows:
        st = str(t.get("status") or "").strip().lower()
        if st not in _CHILD_FULLY_CLOSED:
            open_rows.append(
                {
                    "task_id": str(t.get("id") or "").strip(),
                    "status": st,
                }
            )
    return {
        "total": len(rows),
        "open": len(open_rows),
        "all_done": len(open_rows) == 0,
        "open_rows": open_rows,
    }


def classify_zombie_reclaim(
    task: dict[str, Any],
    *,
    stuck_days: int = 3,
    awaiting_close_days: int = 3,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """Return reclaim action dict or None if task is healthy.

    Actions:
      - stuck_executing_100 → target completed
      - awaiting_close_all_children_done → target completed
      - awaiting_close_orphan_stale (no children, stale) → target completed
    """
    if not isinstance(task, dict):
        return None
    tid = str(task.get("id") or task.get("task_id") or "").strip()
    if not tid:
        return None
    status = str(task.get("status") or "").strip().lower()
    ref = now or datetime.now(UTC)
    name = str(task.get("name") or "").strip()

    if status in _EXECUTING_LIKE and _progress(task) >= 100 and _is_stale(
        task, days=stuck_days, now=ref
    ):
        return {
            "task_id": tid,
            "name": name,
            "from_status": status,
            "to_status": "completed",
            "reason": "stuck_executing_100",
            "progress": _progress(task),
            "updated_at": task.get("updated_at") or task.get("created_at"),
        }

    if status == "awaiting_close" and _is_stale(task, days=awaiting_close_days, now=ref):
        rollup = _children_all_fully_closed(tid)
        if rollup["total"] == 0:
            return {
                "task_id": tid,
                "name": name,
                "from_status": status,
                "to_status": "completed",
                "reason": "awaiting_close_orphan_stale",
                "progress": _progress(task),
                "updated_at": task.get("updated_at") or task.get("created_at"),
                "children_total": 0,
            }
        if rollup["all_done"]:
            return {
                "task_id": tid,
                "name": name,
                "from_status": status,
                "to_status": "completed",
                "reason": "awaiting_close_all_children_done",
                "progress": _progress(task),
                "updated_at": task.get("updated_at") or task.get("created_at"),
                "children_total": rollup["total"],
            }

    return None


def list_zombie_reclaim_candidates(
    *,
    stuck_days: int = 3,
    awaiting_close_days: int = 3,
) -> list[dict[str, Any]]:
    from evoflow.collab.storage import get_project_storage

    storage = get_project_storage()
    now = datetime.now(UTC)
    out: list[dict[str, Any]] = []
    for summary in storage.list_projects():
        proj = storage.load_project(summary["id"])
        if not proj:
            continue
        for task in proj.get("tasks") or []:
            if not isinstance(task, dict):
                continue
            action = classify_zombie_reclaim(
                task,
                stuck_days=stuck_days,
                awaiting_close_days=awaiting_close_days,
                now=now,
            )
            if action:
                out.append(action)
    out.sort(key=lambda r: str(r.get("updated_at") or ""), reverse=True)
    return out


def _apply_reclaim_row(row: dict[str, Any]) -> None:
    from evoflow.admin import tasks as tasks_admin
    from evoflow.admin.errors import ValidationError
    from evoflow.collab.storage import (
        get_project_storage,
        patch_collab_main_task_in_project_storage,
    )
    from evoflow.timeutil import utc_now_iso_z

    tid = str(row.get("task_id") or "")
    target = str(row.get("to_status") or "completed").strip().lower() or "completed"
    reason = str(row.get("reason") or "zombie_reclaim")
    summary = f"auto reclaim: {reason}"
    try:
        tasks_admin.set_task_state(tid, target, summary=summary)
        return
    except ValidationError:
        now = utc_now_iso_z()
        ok = patch_collab_main_task_in_project_storage(
            get_project_storage(),
            tid,
            {
                "status": target,
                "summary": summary,
                "progress": 100 if target == "completed" else row.get("progress"),
                "completed_at": now if target == "completed" else None,
                "updated_at": now,
            },
        )
        if not ok:
            raise ValidationError(f"failed to force-reclaim {tid}")


def reclaim_zombie_tasks(
    *,
    dry_run: bool = True,
    stuck_days: int = 3,
    awaiting_close_days: int = 3,
    limit: int = 0,
) -> dict[str, Any]:
    """Close stuck executing@100 and stale awaiting_close trees. Default dry-run."""
    candidates = list_zombie_reclaim_candidates(
        stuck_days=stuck_days,
        awaiting_close_days=awaiting_close_days,
    )
    if limit and limit > 0:
        candidates = candidates[: int(limit)]
    if dry_run:
        return {
            "ok": True,
            "dry_run": True,
            "count": len(candidates),
            "candidates": candidates,
            "reclaimed": [],
            "errors": [],
        }

    reclaimed: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for row in candidates:
        tid = str(row.get("task_id") or "")
        try:
            _apply_reclaim_row(row)
            reclaimed.append(row)
            logger.info(
                "task_reclaim: %s %s -> %s (%s)",
                tid,
                row.get("from_status"),
                row.get("to_status"),
                row.get("reason"),
            )
        except Exception as e:
            errors.append({"task_id": tid, "error": str(e), **row})
            logger.warning("task_reclaim failed task=%s err=%s", tid, e, exc_info=True)
    return {
        "ok": not errors,
        "dry_run": False,
        "count": len(candidates),
        "candidates": candidates,
        "reclaimed": reclaimed,
        "errors": errors,
    }
