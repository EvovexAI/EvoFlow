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


__all__ = [
    "AdvanceReason",
    "advance_followup_if_workflow",
    "continue_after_step",
    "is_workflow_scheduler_task",
    "retry_wave",
    "start",
]
