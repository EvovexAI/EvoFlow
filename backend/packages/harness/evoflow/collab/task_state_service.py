"""Task state service for unified state management.

This module provides a centralized service for managing task state transitions,
including validation, hooks execution, and history recording.
"""

import json
import logging
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from evoflow.collab.id_format import make_formatted_id
from evoflow.collab.models import TaskStatus
from evoflow.collab.state_transitions import (
    execute_transition_hooks,
    register_transition_hook,
    validate_transition,
)
from evoflow.collab.storage import find_main_task, get_project_storage
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)


# ============================================================================
# State Change Record
# ============================================================================


class TaskStatusChangeRecord(BaseModel):
    """Record of a task status change."""

    id: str = Field(..., description="Record ID")
    task_id: str = Field(..., description="Task ID")
    from_status: str = Field(..., description="Previous status")
    to_status: str = Field(..., description="New status")
    changed_by: str = Field(default="system", description="Who triggered the change")
    changed_at: str = Field(default_factory=utc_now_iso_z, description="Change timestamp")
    reason: str | None = Field(default=None, description="Reason for change")
    metadata: dict[str, Any] = Field(default_factory=dict, description="Additional metadata")

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return self.model_dump()

    def to_json(self) -> str:
        """Convert to JSON string."""
        return self.model_dump_json()


# ============================================================================
# Task State Service
# ============================================================================


class TaskStateService:
    """Service for managing task state transitions.

    This service provides a centralized way to manage task state changes,
    including validation, hooks execution, and history recording.
    """

    def __init__(self):
        self.storage = get_project_storage()
        self._initialize_hooks()

    def _initialize_hooks(self) -> None:
        """Initialize default state transition hooks."""
        # Register default hooks
        register_transition_hook(TaskStatus.PLANNED, TaskStatus.EXECUTING, self._on_start_execution)
        register_transition_hook(TaskStatus.EXECUTING, TaskStatus.PAUSED, self._on_pause)
        register_transition_hook(TaskStatus.PAUSED, TaskStatus.EXECUTING, self._on_resume)
        register_transition_hook(TaskStatus.EXECUTING, TaskStatus.COMPLETED, self._on_complete)
        register_transition_hook(TaskStatus.REVIEWED, TaskStatus.COMPLETED, self._on_complete)
        register_transition_hook(TaskStatus.EXECUTING, TaskStatus.FAILED, self._on_fail)
        register_transition_hook(TaskStatus.EXECUTING, TaskStatus.CANCELLED, self._on_cancel)
        register_transition_hook(TaskStatus.PAUSED, TaskStatus.CANCELLED, self._on_cancel)

    async def transition_state(
        self,
        task_id: str,
        to_status: TaskStatus,
        changed_by: str = "system",
        reason: str | None = None,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Transition a task to a new state.

        Args:
            task_id: Task ID
            to_status: Target status
            changed_by: Who triggered the change (user/system/agent)
            reason: Reason for the change
            context: Additional context for hooks

        Returns:
            Updated task dict

        Raises:
            TaskNotFoundError: If task not found
            InvalidStateTransitionError: If transition not allowed
        """
        context = context or {}

        # 1. Find the task
        row = find_main_task(self.storage, task_id)
        if not row:
            raise TaskNotFoundError(f"Task {task_id} not found")

        project, task = row
        from_status = TaskStatus(task.get("status", "pending"))

        # 2. Validate transition
        validate_transition(from_status, to_status)

        # 3. Execute pre-transition hooks
        execute_transition_hooks(
            from_status,
            to_status,
            {
                "task": task,
                "project": project,
                "context": context,
            },
        )

        # 4. Update timestamps based on transition
        self._update_timestamps(task, from_status, to_status)

        # 5. Update status
        task["status"] = to_status.value
        task["updated_at"] = utc_now_iso_z()

        # 6. Record the state change
        await self._record_state_change(
            task_id=task_id,
            from_status=from_status.value,
            to_status=to_status.value,
            changed_by=changed_by,
            reason=reason,
            metadata=context,
        )

        # 7. Save task
        project["tasks"] = [t if t.get("id") != task_id else task for t in project["tasks"]]
        if not self.storage.save_project(project):
            raise TaskStateError(f"Failed to save task {task_id}")

        logger.info("Task %s transitioned from %s to %s (by %s)", task_id, from_status.value, to_status.value, changed_by)

        return task

    def _update_timestamps(self, task: dict[str, Any], from_status: TaskStatus, to_status: TaskStatus) -> None:
        """Update timestamps based on state transition."""
        now = utc_now_iso_z()

        # PENDING -> PLANNING: record planning start
        if from_status == TaskStatus.PENDING and to_status == TaskStatus.PLANNING:
            task["planning_started_at"] = now

        # PLANNING -> PLANNED: record planning completion
        elif from_status == TaskStatus.PLANNING and to_status == TaskStatus.PLANNED:
            task["planning_completed_at"] = now

        # PLANNED -> EXECUTING: record execution start
        elif from_status == TaskStatus.PLANNED and to_status == TaskStatus.EXECUTING:
            task["execution_started_at"] = now
            task["started_at"] = now

        # EXECUTING -> PAUSED: record pause time
        elif from_status == TaskStatus.EXECUTING and to_status == TaskStatus.PAUSED:
            task["paused_at"] = now

        # PAUSED -> EXECUTING: record resume time
        elif from_status == TaskStatus.PAUSED and to_status == TaskStatus.EXECUTING:
            task["resumed_at"] = now

        # To terminal state: record completion
        elif to_status in (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED):
            task["completed_at"] = now

            # Calculate execution duration
            if task.get("execution_started_at") and task.get("completed_at"):
                try:
                    start = datetime.fromisoformat(task["execution_started_at"].replace("Z", "+00:00"))
                    end = datetime.fromisoformat(task["completed_at"].replace("Z", "+00:00"))
                    task["execution_duration_seconds"] = (end - start).total_seconds()
                except (ValueError, TypeError):
                    pass

    async def _record_state_change(
        self,
        task_id: str,
        from_status: str,
        to_status: str,
        changed_by: str,
        reason: str | None,
        metadata: dict[str, Any],
    ) -> None:
        """Record a state change to the log file."""
        record = TaskStatusChangeRecord(
            id=make_formatted_id("SC"),
            task_id=task_id,
            from_status=from_status,
            to_status=to_status,
            changed_by=changed_by,
            reason=reason,
            metadata=metadata,
        )

        try:
            from evoflow.persistence import repositories as repo

            repo.append_task_status_event(task_id, json.loads(record.to_json()))
        except Exception as e:
            logger.warning("Failed to record state change: %s", e)

    def get_state_history(
        self,
        task_id: str,
        limit: int | None = None,
        offset: int = 0,
    ) -> list[TaskStatusChangeRecord]:
        """Get state change history for a task.

        Args:
            task_id: Task ID
            limit: Maximum number of records to return
            offset: Number of records to skip

        Returns:
            List of state change records
        """
        try:
            from evoflow.persistence import repositories as repo

            raw_rows = repo.list_task_status_events(task_id, offset=offset, limit=limit)
            records: list[TaskStatusChangeRecord] = []
            for data in raw_rows:
                try:
                    records.append(TaskStatusChangeRecord.model_validate(data))
                except Exception:
                    continue
            return records
        except Exception as e:
            logger.warning("Failed to load state history: %s", e)
            return []

    def check_state_consistency(self, task_id: str) -> list[str]:
        """Check for state consistency issues.

        Args:
            task_id: Task ID

        Returns:
            List of issues found
        """
        issues = []

        row = find_main_task(self.storage, task_id)
        if not row:
            return [f"Task {task_id} not found"]

        _project, task = row
        task_status = TaskStatus(task.get("status", "pending"))

        # Check 1: Task status should match expected CollabPhase
        # (This would need access to thread collab state)

        # Check 2: Timestamp consistency
        if task.get("completed_at") and task.get("started_at"):
            try:
                completed = datetime.fromisoformat(task["completed_at"].replace("Z", "+00:00"))
                started = datetime.fromisoformat(task["started_at"].replace("Z", "+00:00"))
                if completed < started:
                    issues.append("completed_at is earlier than started_at")
            except (ValueError, TypeError):
                pass

        # Check 3: Terminal state should have completed_at
        terminal_statuses = {TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED}
        if task_status in terminal_statuses and not task.get("completed_at"):
            issues.append(f"Terminal status {task_status.value} missing completed_at")

        # Check 4: Non-terminal states should not have completed_at in future
        if task_status not in terminal_statuses and task.get("completed_at"):
            issues.append(f"Non-terminal status {task_status.value} has completed_at")

        return issues

    # ============================================================================
    # Transition Hooks
    # ============================================================================

    def _on_start_execution(self, context: dict[str, Any]) -> None:
        """Hook: When task starts executing."""
        task = context.get("task", {})
        logger.info("Task %s starting execution", task.get("id"))

    def _on_pause(self, context: dict[str, Any]) -> None:
        """Hook: When task is paused."""
        task = context.get("task", {})
        logger.info("Task %s paused", task.get("id"))

    def _on_resume(self, context: dict[str, Any]) -> None:
        """Hook: When task is resumed."""
        task = context.get("task", {})
        logger.info("Task %s resumed", task.get("id"))

    def _on_complete(self, context: dict[str, Any]) -> None:
        """Hook: When task completes — write L2 episodic memory."""
        task = context.get("task", {})
        logger.info("Task %s completed", task.get("id"))
        try:
            from evoflow.memory.episodes import record_task_episode

            agent = None
            extra = context.get("context") if isinstance(context.get("context"), dict) else {}
            if isinstance(extra, dict):
                agent = extra.get("agent_name") or extra.get("agent_code")
            ws = None
            project = context.get("project") if isinstance(context.get("project"), dict) else {}
            if isinstance(project, dict):
                ws = project.get("workspace_id") or project.get("workspace_key")
            record_task_episode(
                task if isinstance(task, dict) else None,
                agent_name=str(agent).strip() if agent else None,
                workspace_key=str(ws).strip() if ws else None,
                outcome="completed",
            )
        except Exception:
            logger.debug("task complete → memory episode skipped", exc_info=True)
    def _on_fail(self, context: dict[str, Any]) -> None:
        """Hook: When task fails."""
        task = context.get("task", {})
        logger.info("Task %s failed", task.get("id"))

    def _on_cancel(self, context: dict[str, Any]) -> None:
        """Hook: When task is cancelled."""
        task = context.get("task", {})
        logger.info("Task %s cancelled", task.get("id"))


# ============================================================================
# Exceptions
# ============================================================================


class TaskNotFoundError(Exception):
    """Task not found."""

    pass


class TaskStateError(Exception):
    """Task state error."""

    pass


# ============================================================================
# Singleton Instance
# ============================================================================

_task_state_service: TaskStateService | None = None


def get_task_state_service() -> TaskStateService:
    """Get or create the task state service singleton."""
    global _task_state_service
    if _task_state_service is None:
        _task_state_service = TaskStateService()
    return _task_state_service
