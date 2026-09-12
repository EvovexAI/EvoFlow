"""Task cancellation management module.

Re-exports from evoflow.cancellation for backward compatibility.
The canonical location is now evoflow.cancellation.
"""

from evoflow.cancellation import (
    CancellationError,
    TaskAlreadyTerminatedError,
    TaskCancelledError,
    check_cancellation,
    check_cancellation_periodic,
    cleanup_completed_cancellations,
    clear_all_cancellations,
    get_cancellation_metadata,
    get_cancelled_tasks,
    is_task_cancelled,
    mark_subtasks_cancelled,
    mark_task_cancelled,
    unmark_task_cancelled,
)

__all__ = [
    "mark_task_cancelled",
    "is_task_cancelled",
    "unmark_task_cancelled",
    "mark_subtasks_cancelled",
    "get_cancelled_tasks",
    "get_cancellation_metadata",
    "clear_all_cancellations",
    "cleanup_completed_cancellations",
    "TaskCancelledError",
    "check_cancellation",
    "check_cancellation_periodic",
    "CancellationError",
    "TaskAlreadyTerminatedError",
]
