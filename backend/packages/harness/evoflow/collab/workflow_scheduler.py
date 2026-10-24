"""Workflow DAG scheduler — App-run advancement outside Lead supervisor UX.

Architecture boundary
--------------------
- **Workflow** (``source_app_id`` / workflow-bound): wave-1 and wave-2+ enter here.
  Claim + delegate still reuse the shared execution helpers, but callers must not
  invent a second path past this module for app runs.
- **Lead collab**: keeps ``supervisor_tool(start_execution)`` and
  ``auto_delegate_collab_followup_wave`` for interactive supervision.

After each advance, push ``evoflow_app_runs`` from the main task (write-path).
"""

from __future__ import annotations

import logging
from typing import Any, Literal

logger = logging.getLogger(__name__)

AdvanceReason = Literal["initial", "followup", "retry", "redispatch"]


def is_workflow_scheduler_task(task: dict[str, Any] | None) -> bool:
    """True when DAG advancement should go through this scheduler."""
    if not isinstance(task, dict):
        return False
    if str(task.get("source_app_id") or "").strip():
        return True
    try:
        from evoflow.collab.app_runner import is_workflow_bound_task

        return bool(is_workflow_bound_task(task))
    except Exception:
        return False


def _load_main_task(task_id: str) -> dict[str, Any] | None:
    from evoflow.collab.storage import find_main_task, get_project_storage

    row = find_main_task(get_project_storage(), str(task_id or "").strip())
    if not row:
        return None
    _proj, task = row
    return task if isinstance(task, dict) else None


def _push_app_run(task_id: str, *, reason: str) -> None:
    try:
        from evoflow.collab.app_run_events import emit_app_run_for_task_id

        emit_app_run_for_task_id(task_id, reason=reason)
    except Exception:
        logger.debug("workflow_scheduler: push_app_run failed task_id=%s", task_id, exc_info=True)


async def advance_dag(
    task_id: str,
    *,
    reason: AdvanceReason = "initial",
    authorized_by: str = "api",
    thread_id: str | None = None,
    runtime: Any | None = None,
) -> dict[str, Any]:
    """Advance one DAG wave for a workflow (or workflow-bound) main task.

    - ``initial`` / ``retry`` / ``redispatch`` → authorized ``start_execution`` path
    - ``followup`` → runnable dependents after a subtask terminal (shared delegate)
    """
    tid = str(task_id or "").strip()
    if not tid:
        return {"ok": False, "error": "task_id is required", "reason": reason}

    task = _load_main_task(tid)
    if not task:
        return {"ok": False, "error": "task_not_found", "taskId": tid, "reason": reason}

    if not is_workflow_scheduler_task(task):
        return {
            "ok": False,
            "error": "not_workflow_scheduler_task",
            "taskId": tid,
            "reason": reason,
            "hint": "Lead collab should use supervisor_tool / auto_delegate_collab_followup_wave",
        }

    logger.info(
        "workflow_scheduler.advance_dag task_id=%s reason=%s authorized_by=%s",
        tid,
        reason,
        authorized_by,
    )

    # followup / retry: runnable dependents after terminal (or requeue→pending).
    if reason in ("followup", "retry"):
        from evoflow.tools.builtins.supervisor.execution import auto_delegate_collab_followup_wave

        await auto_delegate_collab_followup_wave(runtime, tid)
        _push_app_run(tid, reason=f"dag_{reason}")
        return {"ok": True, "taskId": tid, "reason": reason, "action": "followup_wave"}

    from evoflow.collab.dispatch_authorized_execution import dispatch_authorized_main_task_execution

    parsed = await dispatch_authorized_main_task_execution(
        tid,
        thread_id=thread_id,
        authorized_by=str(authorized_by or "api").strip() or "api",
    )
    _push_app_run(tid, reason=f"dag_{reason}")
    ok = bool(isinstance(parsed, dict) and (parsed.get("success") or parsed.get("delegatedSubtasks")))
    out: dict[str, Any] = {
        "ok": ok,
        "taskId": tid,
        "reason": reason,
        "action": "start_execution",
        "dispatch": parsed if isinstance(parsed, dict) else {"raw": parsed},
    }
    if not ok and isinstance(parsed, dict):
        out["error"] = str(parsed.get("error") or parsed.get("message") or "dispatch_failed")
    return out


async def advance_followup_if_workflow(
    runtime: Any | None,
    main_task_id: str,
) -> bool:
    """Route follow-up waves for workflow tasks through the scheduler.

    Returns True when this module handled the wave (caller should skip Lead path).
    """
    tid = str(main_task_id or "").strip()
    if not tid:
        return False
    task = _load_main_task(tid)
    if not is_workflow_scheduler_task(task):
        return False
    await advance_dag(tid, reason="followup", runtime=runtime, authorized_by="system")
    return True


__all__ = [
    "AdvanceReason",
    "advance_dag",
    "advance_followup_if_workflow",
    "is_workflow_scheduler_task",
]
