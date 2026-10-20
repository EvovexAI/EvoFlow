"""Task startup acceleration: create-with-assignee ⇒ auto-wake (建单即开工).

When a new Task is created and assigned to another employee (or by 小V to
anyone), immediately wake the assignee with ``related_task_id`` so they start
without a separate ``wake`` tool call.

Self-assign (raised_by / actor == assigned_to) does **not** wake — the operator
is already in-session.

Primary path: ``ProactiveRunner.schedule_dispatch_fire_and_forget`` (same as
item dispatch). Fallback: ``task_assigned`` event bus when runner unavailable.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def should_auto_wake_on_create(
    *,
    assigned_to: str | None,
    raised_by: str | None = None,
    actor: str | None = None,
    status: str | None = None,
) -> bool:
    """True when create should schedule an immediate wake for the assignee."""
    assignee = str(assigned_to or "").strip()
    if not assignee:
        return False
    st = str(status or "").strip().lower().replace("-", "_")
    if st in {"completed", "failed", "cancelled", "reviewed"}:
        return False
    raiser = str(raised_by or "").strip() or str(actor or "").strip()
    if raiser and raiser.lower() == assignee.lower():
        return False
    return True


def maybe_wake_agent_for_new_task(
    task: dict[str, Any],
    runner: Any | None = None,
    *,
    actor: str | None = None,
) -> bool:
    """Schedule immediate agent wake-up for a newly assigned Task.

    Returns True when a wake was scheduled (best-effort; does not wait for run).
    """
    assigned_to = str(task.get("assigned_to") or "").strip()
    task_id = str(task.get("task_id") or task.get("id") or "").strip()
    task_name = str(task.get("name") or "").strip()
    raised_by = str(task.get("raised_by") or "").strip() or None
    status = str(task.get("status") or "").strip() or None

    if not should_auto_wake_on_create(
        assigned_to=assigned_to,
        raised_by=raised_by,
        actor=actor,
        status=status,
    ):
        return False
    if not task_name and not task_id:
        return False

    goal = f"新任务已分配: {task_name}" if task_name else f"新任务已分配: {task_id}"
    description = str(task.get("description") or "").strip() or f"Task ID: {task_id}"
    if task_id and "Task ID" not in description:
        description = f"{description}\nTask ID: {task_id}".strip()

    logger.info(
        "task_startup_accelerator: waking %s for new task %s",
        assigned_to,
        task_id or "?",
    )

    # Preferred: fire-and-forget dispatch with related_task_id (reuses the row).
    try:
        from evoflow.proactive.runner import get_proactive_runner

        active = runner if runner is not None else get_proactive_runner()
        if active is not None and hasattr(active, "schedule_dispatch_fire_and_forget"):
            active.schedule_dispatch_fire_and_forget(
                assigned_to,
                goal,
                description=description,
                related_task_id=task_id,
                source="task_assigned",
                priority="normal",
            )
            return True
    except Exception:
        logger.debug("task_startup_accelerator: schedule_dispatch failed", exc_info=True)

    # Fallback: event bus (legacy / no runner loop yet).
    try:
        import asyncio

        async def _wake() -> None:
            from evoflow.proactive.triggers import get_event_bus

            bus = get_event_bus(runner)
            if bus:
                await bus.emit(
                    event_type="task_assigned",
                    agent_code=assigned_to,
                    goal=goal,
                    description=description,
                )

        try:
            loop = asyncio.get_running_loop()
            loop.create_task(_wake())
            return True
        except RuntimeError:
            pass
    except Exception as e:
        logger.debug("task_startup_accelerator: wake emit failed: %s", e, exc_info=True)
    return False
