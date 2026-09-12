"""Task cancellation flag management.

Provides global cancellation state management for tasks and subtasks.
Uses thread-safe data structures for concurrent access.
"""

import logging
import threading

from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

# Global storage for cancelled task IDs
_cancelled_tasks: set[str] = set()
_cancelled_lock = threading.RLock()

# Cancellation metadata (when, by whom, etc.)
_cancellation_metadata: dict[str, dict] = {}
_metadata_lock = threading.RLock()


def mark_task_cancelled(task_id: str, cancelled_by: str = "user", reason: str = "") -> bool:
    """Mark a task as cancelled.

    Args:
        task_id: Task ID to mark as cancelled
        cancelled_by: Who cancelled the task (default: "user")
        reason: Cancellation reason

    Returns:
        True if task was newly marked, False if already marked
    """
    with _cancelled_lock:
        if task_id in _cancelled_tasks:
            return False
        _cancelled_tasks.add(task_id)

    # Store metadata
    with _metadata_lock:
        _cancellation_metadata[task_id] = {
            "cancelled_at": utc_now_iso_z(),
            "cancelled_by": cancelled_by,
            "reason": reason,
        }

    logger.info(f"Task {task_id} marked as cancelled by {cancelled_by}")
    return True


def is_task_cancelled(task_id: str) -> bool:
    """Check if a task has been marked as cancelled.

    Args:
        task_id: Task ID to check

    Returns:
        True if task is cancelled
    """
    with _cancelled_lock:
        return task_id in _cancelled_tasks


def unmark_task_cancelled(task_id: str) -> bool:
    """Remove cancellation mark from a task.

    Called when task cleanup is complete or task is restarted.

    Args:
        task_id: Task ID to unmark

    Returns:
        True if task was unmarked, False if not found
    """
    with _cancelled_lock:
        removed = task_id in _cancelled_tasks
        _cancelled_tasks.discard(task_id)

    if removed:
        with _metadata_lock:
            _cancellation_metadata.pop(task_id, None)
        logger.info(f"Task {task_id} unmarked as cancelled")

    return removed


def mark_subtasks_cancelled(project_id: str, task_id: str, cancelled_by: str = "user") -> list[str]:
    """Mark all subtasks of a task as cancelled.

    Args:
        project_id: Project ID
        task_id: Main task ID
        cancelled_by: Who cancelled the task

    Returns:
        List of subtask IDs that were marked as cancelled
    """
    from evoflow.collab.storage import find_main_task, get_project_storage

    storage = get_project_storage()
    row = find_main_task(storage, task_id)

    if not row:
        logger.warning(f"Task {task_id} not found for subtask cancellation")
        return []

    project, task = row
    subtask_ids = []

    for subtask in task.get("subtasks", []):
        subtask_id = subtask.get("id")
        if subtask_id:
            status = subtask.get("status")
            if status not in ("completed", "failed", "cancelled"):
                if mark_task_cancelled(subtask_id, cancelled_by, "parent_task_cancelled"):
                    subtask_ids.append(subtask_id)

    logger.info(f"Marked {len(subtask_ids)} subtasks of task {task_id} as cancelled")
    return subtask_ids


def get_cancelled_tasks() -> set[str]:
    """Get all currently cancelled task IDs.

    Returns:
        Set of cancelled task IDs
    """
    with _cancelled_lock:
        return _cancelled_tasks.copy()


def get_cancellation_metadata(task_id: str) -> dict | None:
    """Get cancellation metadata for a task.

    Args:
        task_id: Task ID

    Returns:
        Cancellation metadata or None
    """
    with _metadata_lock:
        return _cancellation_metadata.get(task_id)


def clear_all_cancellations() -> int:
    """Clear all cancellation marks. Use with caution.

    Returns:
        Number of tasks cleared
    """
    with _cancelled_lock:
        count = len(_cancelled_tasks)
        _cancelled_tasks.clear()

    with _metadata_lock:
        _cancellation_metadata.clear()

    logger.warning(f"Cleared all {count} cancellation marks")
    return count


def cleanup_completed_cancellations(task_ids: list[str]) -> int:
    """Remove cancellation marks for completed tasks.

    Args:
        task_ids: List of task IDs that have completed cleanup

    Returns:
        Number of tasks cleaned up
    """
    count = 0
    with _cancelled_lock:
        for task_id in task_ids:
            if task_id in _cancelled_tasks:
                _cancelled_tasks.discard(task_id)
                count += 1

    with _metadata_lock:
        for task_id in task_ids:
            _cancellation_metadata.pop(task_id, None)

    if count > 0:
        logger.info(f"Cleaned up {count} completed cancellation marks")

    return count
