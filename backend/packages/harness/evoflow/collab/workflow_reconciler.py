"""DB-driven workflow recover — heal zombies / requeue failed → Runtime advance.

See ``docs/design/workflow-crash-resume.md``. Memory monitors are disposable;
this module re-reads project storage + app_runs and calls ``workflow_runtime``.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

from evoflow.collab.runner_epoch import current_runner_epoch
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_IN_FLIGHT = frozenset({"executing", "running", "in_progress", "active", "planning"})
_FAILED = frozenset({"failed", "error", "timed_out"})
_PAUSED = frozenset({"paused", "interrupted", "pausing"})
_PENDING_LIKE = frozenset({"pending", "planned", "waiting_dispatch"})
_OPEN_APP_RUN = frozenset(
    {"running", "executing", "paused", "pausing", "interrupted", "failed", "error"}
)


def _auto_retry_max() -> int:
    from evoflow.tools.builtins.supervisor.dependency import subtask_auto_retry_max

    return subtask_auto_retry_max()


def _stale_updated_seconds() -> float:
    raw = (os.getenv("EVOFLOW_WORKFLOW_ZOMBIE_STALE_S") or "600").strip()
    try:
        return max(60.0, float(raw))
    except ValueError:
        return 600.0


def _parse_iso_ts(raw: Any) -> float | None:
    s = str(raw or "").strip()
    if not s:
        return None
    try:
        from datetime import datetime

        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s).timestamp()
    except Exception:
        return None


def is_zombie_executing_subtask(
    st: dict[str, Any],
    *,
    now_ts: float | None = None,
    reason: str = "tick",
) -> bool:
    """True when an in-flight row has no live worker and looks abandoned after crash."""
    if not isinstance(st, dict):
        return False
    status = str(st.get("status") or "").strip().lower()
    if status not in _IN_FLIGHT:
        return False

    from evoflow.subagents.runtime_guard import is_subtask_background_executor_active

    if is_subtask_background_executor_active(st):
        return False

    now = float(now_ts if now_ts is not None else time.time())
    epoch = current_runner_epoch()
    row_epoch = str(st.get("runner_epoch") or "").strip()
    if row_epoch and row_epoch != epoch:
        return True

    try:
        lease_until = float(st.get("lease_until_ts") or 0.0)
    except (TypeError, ValueError):
        lease_until = 0.0
    if lease_until > 0 and now > lease_until:
        return True

    # Pre-epoch rows / missing lease: on boot treat as zombie; on tick use updated_at stale.
    if reason == "boot" and not row_epoch:
        return True
    updated = _parse_iso_ts(st.get("updated_at") or st.get("started_at"))
    if updated is not None and (now - updated) >= _stale_updated_seconds():
        return True
    return False


def _heal_subtasks(
    task: dict[str, Any],
    *,
    reason: str,
    now_ts: float,
) -> list[dict[str, Any]]:
    """Mutate subtask rows in-place; return heal records."""
    from evoflow.collab.subtask_state_machine import advance_subtask_row_status

    healed: list[dict[str, Any]] = []
    max_retry = _auto_retry_max()
    now_iso = utc_now_iso_z()
    for st in task.get("subtasks") or []:
        if not isinstance(st, dict):
            continue
        sid = str(st.get("id") or "").strip()
        if not sid:
            continue
        prev = str(st.get("status") or "").strip().lower()

        if is_zombie_executing_subtask(st, now_ts=now_ts, reason=reason):
            ok, why = advance_subtask_row_status(st, "pending", allow_terminal_downgrade=False)
            if not ok:
                st["status"] = "pending"
                why = why or "forced_pending"
            st["error"] = f"reconcile:{reason}:zombie_executing"
            st["updated_at"] = now_iso
            st.pop("lease_until_ts", None)
            st.pop("background_task_id", None)
            healed.append({"subtaskId": sid, "from": prev, "to": "pending", "why": "zombie_executing"})
            continue

        if prev in _PAUSED:
            ok, why = advance_subtask_row_status(st, "pending", allow_terminal_downgrade=False)
            if not ok:
                st["status"] = "pending"
            st["updated_at"] = now_iso
            healed.append({"subtaskId": sid, "from": prev, "to": "pending", "why": "paused_resume"})
            continue

        if prev in _FAILED:
            auto_n = int(st.get("auto_retry_count") or 0)
            if auto_n >= max_retry:
                continue
            ok, why = advance_subtask_row_status(
                st,
                "pending",
                allow_terminal_downgrade=True,
            )
            if not ok:
                st["status"] = "pending"
            st["auto_retry_count"] = auto_n + 1
            st["retry_count"] = int(st.get("retry_count") or 0) + 1
            st["error"] = f"reconcile:{reason}:retry_failed"
            st["updated_at"] = now_iso
            st.pop("lease_until_ts", None)
            healed.append(
                {
                    "subtaskId": sid,
                    "from": prev,
                    "to": "pending",
                    "why": "failed_retry",
                    "autoRetryCount": st["auto_retry_count"],
                }
            )

    return healed


def _has_runnable_pending(task: dict[str, Any]) -> bool:
    for st in task.get("subtasks") or []:
        if isinstance(st, dict) and str(st.get("status") or "").strip().lower() in _PENDING_LIKE:
            return True
    return False


def _has_live_executing(task: dict[str, Any]) -> bool:
    from evoflow.subagents.runtime_guard import is_subtask_background_executor_active

    for st in task.get("subtasks") or []:
        if not isinstance(st, dict):
            continue
        if str(st.get("status") or "").strip().lower() not in _IN_FLIGHT:
            continue
        if is_subtask_background_executor_active(st):
            return True
        # Still in-flight but not zombie yet (lease valid, same epoch)
        if not is_zombie_executing_subtask(st, reason="tick"):
            return True
    return False


async def reconcile_task(
    task_id: str,
    *,
    reason: str = "manual",
    dispatch: bool = True,
) -> dict[str, Any]:
    """Heal one main task and optionally advance the DAG."""
    from evoflow.collab.storage import find_main_task, get_project_storage, main_task_mutation_lock
    from evoflow.collab.workflow_scheduler import is_workflow_scheduler_task

    tid = str(task_id or "").strip()
    report: dict[str, Any] = {
        "ok": False,
        "taskId": tid,
        "reason": reason,
        "healed": [],
        "action": "noop",
        "error": None,
    }
    if not tid:
        report["error"] = "task_id required"
        return report

    storage = get_project_storage()
    now_ts = time.time()
    healed: list[dict[str, Any]] = []

    with main_task_mutation_lock(tid):
        row = find_main_task(storage, tid, bypass_cache=True)
        if not row:
            report["error"] = "task_not_found"
            return report
        project, task = row
        if not is_workflow_scheduler_task(task):
            report["error"] = "not_workflow_task"
            return report

        healed = _heal_subtasks(task, reason=reason, now_ts=now_ts)
        if healed:
            main_st = str(task.get("status") or "").strip().lower()
            if main_st in _PAUSED | _FAILED | {"cancelled", "canceled"}:
                # Re-open for dispatch (state machine on main is looser via direct assign).
                if main_st in _PAUSED or main_st in _FAILED:
                    task["status"] = "executing"
            task["updated_at"] = utc_now_iso_z()
            storage.save_project(project)
            try:
                from evoflow.collab.app_run_events import emit_app_run_from_main_task

                emit_app_run_from_main_task(task, reason=f"reconcile_{reason}")
            except Exception:
                logger.debug("reconcile emit_app_run failed task=%s", tid, exc_info=True)

    report["healed"] = healed
    report["ok"] = True

    if not dispatch:
        report["action"] = "heal_only"
        return report

    # Decide Runtime entry
    row2 = find_main_task(storage, tid, bypass_cache=True)
    task2 = row2[1] if row2 else task
    need_retry = any(h.get("why") in {"zombie_executing", "failed_retry"} for h in healed)
    need_start = any(h.get("why") == "paused_resume" for h in healed) or (
        not healed and _has_runnable_pending(task2) and not _has_live_executing(task2)
    )

    if not healed and not need_start:
        report["action"] = "noop"
        return report

    try:
        from evoflow.collab import workflow_runtime

        if need_retry:
            result = await workflow_runtime.retry_wave(tid, authorized_by=f"reconcile:{reason}")
            report["action"] = "retry_wave"
            report["dispatch"] = result
        else:
            result = await workflow_runtime.start(tid, authorized_by=f"reconcile:{reason}")
            report["action"] = "start"
            report["dispatch"] = result
    except Exception as e:
        logger.exception("reconcile dispatch failed task=%s", tid)
        report["error"] = str(e)
        report["action"] = "dispatch_failed"
        report["ok"] = False

    return report


async def reconcile_run(
    run_id: str,
    *,
    reason: str = "manual",
) -> dict[str, Any]:
    """Recover an app run by id (failed / paused / zombie mid-flight)."""
    from evoflow.persistence import app_repositories

    rid = str(run_id or "").strip()
    out: dict[str, Any] = {"ok": False, "runId": rid, "error": None}
    if not rid:
        out["error"] = "runId required"
        return out
    run = app_repositories.load_run(rid)
    if run is None:
        out["error"] = "run_not_found"
        return out
    st = str(run.get("status") or "").strip().lower()
    if st in {"cancelled", "canceled", "completed", "success"}:
        out["error"] = f"run_terminal:{st}"
        return out

    task_id = str(run.get("task_id") or "").strip()
    if not task_id:
        out["error"] = "run_missing_task_id"
        return out

    # Ensure app_run not stuck in failed while we retry
    if st in _FAILED | _PAUSED:
        try:
            app_repositories.update_run_status(rid, "running")
        except Exception:
            logger.debug("reconcile_run: update status failed run=%s", rid, exc_info=True)

    report = await reconcile_task(task_id, reason=reason, dispatch=True)
    out.update(report)
    out["runId"] = rid
    out["ok"] = bool(report.get("ok"))
    return out


async def reconcile_open_workflows(
    *,
    limit: int = 50,
    reason: str = "tick",
) -> dict[str, Any]:
    """Scan open app runs and reconcile each linked workflow task."""
    from evoflow.persistence import app_repositories

    lim = max(1, min(int(limit or 50), 200))
    runs = app_repositories.list_open_runs(limit=lim)
    reports: list[dict[str, Any]] = []
    for run in runs:
        rid = str(run.get("id") or "").strip()
        tid = str(run.get("task_id") or "").strip()
        if not tid:
            continue
        try:
            if rid:
                rep = await reconcile_run(rid, reason=reason)
            else:
                rep = await reconcile_task(tid, reason=reason)
            reports.append(rep)
        except Exception as e:
            logger.exception("reconcile_open failed run=%s task=%s", rid, tid)
            reports.append({"ok": False, "runId": rid, "taskId": tid, "error": str(e)})

    healed_n = sum(len(r.get("healed") or []) for r in reports if isinstance(r, dict))
    return {
        "ok": True,
        "reason": reason,
        "scanned": len(runs),
        "reports": reports,
        "healedCount": healed_n,
        "runnerEpoch": current_runner_epoch(),
    }


__all__ = [
    "is_zombie_executing_subtask",
    "reconcile_open_workflows",
    "reconcile_run",
    "reconcile_task",
]
