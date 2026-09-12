"""Helpers to hide / clean task-center noise (receipts / meeting speak / status checks)."""

from __future__ import annotations

from typing import Any

_MEETING_RAISERS = frozenset({"meeting_orchestrator"})
_NOISE_CHANNELS = frozenset({"status_check", "upstream_receipt", "proactive_patrol"})
_PLACEHOLDER_NAMES = frozenset({"main", "t", "smoke", "fan", "规划任务", "x"})
_RECEIPT_PREFIX = "【下游回执】"
_PATROL_TITLE_PREFIXES = ("【巡检】", "【值班】", "[巡检]", "[值班]")


def is_duty_patrol_task(task: dict[str, Any] | None) -> bool:
    """Routine employee heartbeat / duty round — not user-facing task-center work."""
    if not isinstance(task, dict):
        return False
    name = str(task.get("name") or task.get("title") or "").strip()
    if not name:
        return False
    channel = str(task.get("source_channel") or "").strip().lower()
    if channel == "proactive_patrol":
        return True
    if any(name.startswith(prefix) for prefix in _PATROL_TITLE_PREFIXES):
        return True
    if "值班巡检" in name:
        return True
    if (name.startswith("巡检：") or name.startswith("巡检:")) and len(name) < 80:
        return True
    if name.endswith("值班") and ("【" in name or "巡检" in name):
        return True
    if task.get("proactive_work_item") and any(m in name for m in ("巡检", "值班")):
        # Substantive dispatch titles (处理/审核…) stay visible.
        if name.startswith("处理：") or name.startswith("处理:"):
            return False
        return True
    return False


def is_task_center_noise(task: dict[str, Any] | None) -> bool:
    """True when a main-task row should be hidden from the default task-center list."""
    if not isinstance(task, dict):
        return False
    name = str(task.get("name") or "").strip()
    channel = str(task.get("source_channel") or "").strip().lower()
    raised = str(task.get("raised_by") or "").strip().lower()
    woken = str(task.get("woken_by") or "").strip().lower()
    desc = str(task.get("description") or "")

    if channel in _NOISE_CHANNELS:
        return True
    if is_duty_patrol_task(task):
        return True
    if name.startswith(_RECEIPT_PREFIX):
        return True
    if raised in _MEETING_RAISERS or woken in _MEETING_RAISERS:
        if (
            "口头汇报" in name
            or name == "汇报每个人工作进度"
            or name.startswith("【圆桌会议")
        ):
            return True
    if "EVAL_LIVE" in name or "live_wake eval" in desc.lower():
        return True
    if name in _PLACEHOLDER_NAMES:
        src = str(task.get("source") or "").strip().lower()
        if src in {"", "conversation", "chat"} or not src:
            return True
    return False


def classify_noise_cleanup_reason(
    task: dict[str, Any],
    *,
    stuck_days: int = 3,
    now: Any = None,
) -> str | None:
    """Return cleanup reason code if this main task is safe noise to cancel, else None.

    Does **not** flag completed real business duplicates (e.g. two API builds).
    ``stuck_days`` / ``now`` kept for API compat; stuck executing is handled by
    :mod:`evoflow.collab.task_reclaim`.
    """
    _ = stuck_days, now
    if not isinstance(task, dict):
        return None
    name = str(task.get("name") or "").strip()
    desc = str(task.get("description") or "")
    raised = str(task.get("raised_by") or "").strip().lower()
    woken = str(task.get("woken_by") or "").strip().lower()
    channel = str(task.get("source_channel") or "").strip().lower()
    src = str(task.get("source") or "").strip().lower()

    if "EVAL_LIVE" in name or "live_wake eval" in desc.lower():
        return "eval_live"
    if name.startswith(_RECEIPT_PREFIX):
        return "upstream_receipt_wrapper"
    if raised in _MEETING_RAISERS or woken in _MEETING_RAISERS:
        if (
            "口头汇报" in name
            or name == "汇报每个人工作进度"
            or name.startswith("【圆桌会议")
        ):
            return "meeting_oral_report"
    if channel == "status_check":
        return "status_check"
    if is_duty_patrol_task(task):
        st = str(task.get("status") or "").strip().lower()
        if st in {"pending", "planning", "planned", "executing", "in_progress", "running"}:
            return "duty_patrol"
    if name in _PLACEHOLDER_NAMES and src in {"", "conversation", "chat"}:
        return "placeholder_name"

    # Stuck executing@100% is owned by task_reclaim (→ completed), not noise cancel.
    return None


def list_noise_cleanup_candidates(
    *,
    stuck_days: int = 3,
) -> list[dict[str, Any]]:
    """Scan board storage for cancelable noise rows (dry-run friendly)."""
    from evoflow.collab.storage import get_project_storage

    storage = get_project_storage()
    out: list[dict[str, Any]] = []
    for summary in storage.list_projects():
        proj = storage.load_project(summary["id"])
        if not proj:
            continue
        for task in proj.get("tasks") or []:
            if not isinstance(task, dict):
                continue
            reason = classify_noise_cleanup_reason(task, stuck_days=stuck_days)
            if not reason:
                continue
            st = str(task.get("status") or "").strip().lower()
            if st in {"cancelled", "canceled", "deleted"}:
                continue
            tid = str(task.get("id") or "").strip()
            if not tid:
                continue
            out.append(
                {
                    "task_id": tid,
                    "name": str(task.get("name") or ""),
                    "status": st,
                    "progress": task.get("progress"),
                    "reason": reason,
                    "updated_at": task.get("updated_at") or task.get("created_at"),
                    "raised_by": task.get("raised_by"),
                    "source": task.get("source"),
                    "source_channel": task.get("source_channel"),
                }
            )
    out.sort(key=lambda r: str(r.get("updated_at") or ""), reverse=True)
    return out


def cleanup_noise_tasks(
    *,
    dry_run: bool = True,
    stuck_days: int = 3,
    limit: int = 0,
) -> dict[str, Any]:
    """Cancel classified noise tasks. Default dry_run=True (list only)."""
    candidates = list_noise_cleanup_candidates(stuck_days=stuck_days)
    if limit and limit > 0:
        candidates = candidates[: int(limit)]
    cancelled: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    if dry_run:
        return {
            "ok": True,
            "dry_run": True,
            "count": len(candidates),
            "candidates": candidates,
            "cancelled": [],
            "errors": [],
        }

    from evoflow.admin import tasks as tasks_admin
    from evoflow.admin.errors import ValidationError
    from evoflow.collab.storage import (
        get_project_storage,
        patch_collab_main_task_in_project_storage,
    )
    from evoflow.timeutil import utc_now_iso_z

    storage = get_project_storage()
    now = utc_now_iso_z()
    for row in candidates:
        tid = str(row.get("task_id") or "")
        summary = f"noise cleanup: {row.get('reason')}"
        try:
            try:
                tasks_admin.set_task_state(tid, "cancelled", summary=summary)
            except ValidationError:
                # completed/failed are terminal — force-cancel noise wrappers.
                ok = patch_collab_main_task_in_project_storage(
                    storage,
                    tid,
                    {
                        "status": "cancelled",
                        "summary": summary,
                        "failed_at": now,
                        "updated_at": now,
                    },
                )
                if not ok:
                    raise ValidationError(f"failed to force-cancel {tid}")
            cancelled.append(row)
        except Exception as e:
            errors.append({"task_id": tid, "error": str(e), **row})
    return {
        "ok": not errors,
        "dry_run": False,
        "count": len(candidates),
        "candidates": candidates,
        "cancelled": cancelled,
        "errors": errors,
    }
