"""Task-related event definitions.

This module defines dataclasses for events related to task lifecycle.
"""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime


@dataclass
class TaskAuthorizedEvent:
    """Event fired when a task is authorized for execution.

    This event triggers the actual execution of subtasks via supervisor_tool.
    """

    task_id: str
    project_id: str
    authorized_by: str
    thread_id: str | None
    timestamp: datetime
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    source: str = "api"  # "api", "system", "automation"

    @classmethod
    def from_request(
        cls,
        task_id: str,
        project_id: str,
        authorized_by: str = "user",
        thread_id: str | None = None,
        source: str = "api",
    ) -> "TaskAuthorizedEvent":
        """Create event from API request parameters."""
        return cls(
            task_id=task_id,
            project_id=project_id,
            authorized_by=authorized_by,
            thread_id=thread_id,
            timestamp=datetime.now(UTC),
            source=source,
        )


@dataclass
class TaskExecutionStartedEvent:
    """Event fired when task execution actually starts (subtasks are delegated)."""

    task_id: str
    project_id: str
    started_at: datetime
    subtask_count: int
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    triggered_by: str = "system"  # "user", "system", "automation"


@dataclass
class TaskExecutionFailedEvent:
    """Event fired when task execution fails to start."""

    task_id: str
    project_id: str
    error: str
    failed_at: datetime
    retryable: bool
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    attempt_count: int = 1


@dataclass
class TaskCancelEvent:
    """Event fired when a task is cancelled."""

    task_id: str
    project_id: str
    subtask_ids: list[str]
    cancelled_by: str
    reason: str
    timestamp: datetime
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))

    @classmethod
    def from_request(
        cls,
        task_id: str,
        project_id: str,
        subtask_ids: list[str],
        cancelled_by: str = "user",
        reason: str = "",
    ) -> "TaskCancelEvent":
        """Create event from API request parameters."""
        return cls(
            task_id=task_id,
            project_id=project_id,
            subtask_ids=subtask_ids,
            cancelled_by=cancelled_by,
            reason=reason,
            timestamp=datetime.now(UTC),
        )


@dataclass
class TaskCancelledEvent:
    """Event fired when task cancellation is complete."""

    task_id: str
    project_id: str
    cancelled_at: datetime
    cancelled_by: str
    subtask_count: int
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))


@dataclass
class TaskResumeEvent:
    """Event fired when a paused task is resumed."""

    task_id: str
    project_id: str
    resumed_by: str
    timestamp: datetime
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    source: str = "api"  # "api", "system", "automation"

    @classmethod
    def from_request(
        cls,
        task_id: str,
        project_id: str,
        resumed_by: str = "user",
        source: str = "api",
    ) -> "TaskResumeEvent":
        """Create event from API request parameters."""
        return cls(
            task_id=task_id,
            project_id=project_id,
            resumed_by=resumed_by,
            timestamp=datetime.now(UTC),
            source=source,
        )
