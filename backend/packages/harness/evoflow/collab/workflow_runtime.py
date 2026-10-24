"""App Workflow Runtime — public boundary outside Lead supervisor UX.

Architecture
------------
- **This module**: App / workflow-bound DAG lifecycle (start, continue, retry).
- **Lead collab**: ``supervisor_tool(start_execution)`` + registered follow-up handler.
- **Shared Step Runner**: ``collab.step_runner`` (claim + ``run_steps``).

Callers (``app_runner.dispatch_workflow_task_*``, platform actions, automation)
should enter here rather than supervisor tools directly.
"""

from __future__ import annotations

from typing import Any

from evoflow.collab.workflow_scheduler import (
    AdvanceReason,
    advance_dag,
    advance_followup_if_workflow,
    is_workflow_scheduler_task,
)


async def start(
    task_id: str,
    *,
    authorized_by: str = "api",
    thread_id: str | None = None,
) -> dict[str, Any]:
    """Wave-1: authorize path + first runnable claim/delegate."""
    return await advance_dag(
        task_id,
        reason="initial",
        authorized_by=authorized_by,
        thread_id=thread_id,
    )


async def continue_after_step(
    task_id: str,
    *,
    runtime: Any | None = None,
) -> dict[str, Any]:
    """Wave-2+: after a subtask reaches terminal, start newly runnable dependents."""
    return await advance_dag(
        task_id,
        reason="followup",
        runtime=runtime,
        authorized_by="system",
    )


async def retry_wave(
    task_id: str,
    *,
    runtime: Any | None = None,
    authorized_by: str = "system",
) -> dict[str, Any]:
    """After monitor/API requeue cleared terminal→pending, advance runnable wave."""
    return await advance_dag(
        task_id,
        reason="retry",
        runtime=runtime,
        authorized_by=authorized_by,
    )


def _load_main_task(task_id: str) -> dict[str, Any] | None:
    from evoflow.collab.storage import find_main_task, get_project_storage

    row = find_main_task(get_project_storage(), str(task_id or "").strip())
    if not row:
        return None
    _proj, task = row
    return task if isinstance(task, dict) else None


async def dispatch_for_task(
    task_id: str,
    *,
    authorized_by: str = "api",
    thread_id: str | None = None,
) -> dict[str, Any]:
    """Unified wave-1 entry: App → ``start``; Lead → ``dispatch_authorized``.

    Returns a supervisor-shaped dict (``success`` / ``delegatedSubtasks`` / ``error``)
    so gateway / unattended callers stay unchanged.
    """
    tid = str(task_id or "").strip()
    if not tid:
        return {"success": False, "error": "task_id is required"}

    task = _load_main_task(tid)
    if is_workflow_scheduler_task(task):
        scheduled = await start(tid, authorized_by=authorized_by, thread_id=thread_id)
        parsed = scheduled.get("dispatch") if isinstance(scheduled, dict) else None
        if isinstance(parsed, dict):
            return parsed
        return {
            "success": bool(scheduled.get("ok")) if isinstance(scheduled, dict) else False,
            "taskId": tid,
            "error": (scheduled or {}).get("error") if isinstance(scheduled, dict) else "dispatch_failed",
            "action": "start_execution",
        }

    from evoflow.collab.dispatch_authorized_execution import dispatch_authorized_main_task_execution

    return await dispatch_authorized_main_task_execution(
        tid,
        thread_id=thread_id,
        authorized_by=str(authorized_by or "api").strip() or "api",
    )


__all__ = [
    "AdvanceReason",
    "advance_followup_if_workflow",
    "continue_after_step",
    "dispatch_for_task",
    "is_workflow_scheduler_task",
    "retry_wave",
    "start",
]
