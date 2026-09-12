"""Task cancellation management module.

Provides cancellation flag management and cooperative cancellation checks.
"""

from .cancellation_checks import (
    TaskCancelledError,
    check_cancellation,
    check_cancellation_periodic,
)
from .exceptions import CancellationError, TaskAlreadyTerminatedError
from .task_cancellation import (
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
