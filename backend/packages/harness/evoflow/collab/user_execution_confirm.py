"""User-confirmed execution: authorize only; Lead dispatches via supervisor(start_execution)."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

from evoflow.config.paths import Paths, get_paths
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_CONFIRM_TTL_SECONDS = 600


def mark_user_execution_confirmed(paths: Paths, thread_id: str) -> None:
    """Record that the user explicitly confirmed execution on this thread."""
    from evoflow.collab.thread_collab import load_thread_collab_state, merge_thread_collab_state, save_thread_collab_state

    tid = str(thread_id or "").strip()
    if not tid:
        return
    cur = load_thread_collab_state(paths, tid)
    merged = merge_thread_collab_state(
        cur,
        {"user_execution_confirmed_at": utc_now_iso_z()},
    )
    save_thread_collab_state(paths, tid, merged)


def thread_has_recent_user_execution_confirm(
    paths: Paths,
    thread_id: str,
    *,
    max_age_seconds: int = _CONFIRM_TTL_SECONDS,
) -> bool:
    from evoflow.collab.thread_collab import load_thread_collab_state

    tid = str(thread_id or "").strip()
    if not tid:
        return False
    try:
        st = load_thread_collab_state(paths, tid)
        raw = str(getattr(st, "user_execution_confirmed_at", None) or "").strip()
        if not raw:
            return False
        ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=UTC)
        age = (datetime.now(UTC) - ts).total_seconds()
        return age <= max(60, int(max_age_seconds))
    except Exception:
        return False


def dispatch_started(dispatch: dict[str, Any] | None) -> bool:
    if not dispatch or not dispatch.get("success"):
        return False
    ids = dispatch.get("subtaskIds")
    if isinstance(ids, list) and len(ids) > 0:
        return True
    delegated = dispatch.get("delegatedSubtasks")
    if isinstance(delegated, list):
        return any(isinstance(d, dict) and d.get("ok") for d in delegated)
    return False


async def confirm_user_execution_and_dispatch(
    task_id: str,
    *,
    thread_id: str | None = None,
    authorized_by: str = "user",
) -> dict[str, Any]:
    """Authorize main task (same gate as HTTP authorize-execution). Does not dispatch workers."""
    from evoflow.collab.authorize_execution import authorize_main_task_execution, is_task_execution_authorized
    from evoflow.collab.storage import find_main_task, get_project_storage

    tid = str(task_id or "").strip()
    run_tid = str(thread_id or "").strip() or None
    out: dict[str, Any] = {
        "success": False,
        "action": "user_execution_confirm",
        "taskId": tid,
    }
    if not tid:
        out["error"] = "task_id is required"
        return out

    paths = get_paths()
    if run_tid:
        mark_user_execution_confirmed(paths, run_tid)

    storage = get_project_storage()
    ok, msg = authorize_main_task_execution(storage, tid, authorized_by)
    out["authorizeOk"] = ok
    out["authorizeMessage"] = msg
    if not ok and "already" not in msg.lower():
        out["error"] = "authorize_failed"
        out["message"] = msg
        return out

    if not find_main_task(storage, tid):
        out["error"] = "task_not_found"
        return out

    out["success"] = bool(is_task_execution_authorized(storage, tid))
    out["executionAuthorized"] = out["success"]
    out["message"] = "已授权；由 Lead 在本轮调用 supervisor(start_execution) 派发子任务。"
    return out


def schedule_user_execution_confirm_dispatch(
    task_id: str,
    *,
    thread_id: str | None = None,
    authorized_by: str = "user",
) -> None:
    """Fire-and-forget: persist execution_authorized without blocking the LangGraph model step."""

    async def _job() -> None:
        try:
            result = await confirm_user_execution_and_dispatch(
                task_id,
                thread_id=thread_id,
                authorized_by=authorized_by,
            )
            logger.info(
                "schedule_user_execution_confirm_dispatch: task_id=%s success=%s dispatch=%s",
                task_id,
                result.get("success"),
                dispatch_started(result.get("dispatch") if isinstance(result.get("dispatch"), dict) else None),
            )
        except Exception:
            logger.exception(
                "schedule_user_execution_confirm_dispatch failed task_id=%s",
                task_id,
            )

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_job())
    except RuntimeError:
        asyncio.run(_job())


__all__ = [
    "mark_user_execution_confirmed",
    "thread_has_recent_user_execution_confirm",
    "confirm_user_execution_and_dispatch",
    "schedule_user_execution_confirm_dispatch",
    "dispatch_started",
]
