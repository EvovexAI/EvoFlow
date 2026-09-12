"""Cancellation-related exceptions."""


class CancellationError(Exception):
    """Base exception for cancellation-related errors."""

    pass


class TaskCancelledError(CancellationError):
    """Raised when a task is cancelled during execution.

    Execution points should catch this exception and perform cleanup.
    """

    def __init__(self, task_id: str, message: str = "", *args):
        self.task_id = task_id
        self.message = message or f"Task {task_id} has been cancelled"
        super().__init__(self.message, *args)


class TaskAlreadyTerminatedError(CancellationError):
    """Raised when trying to cancel a task that is already terminated.

    Task states: completed, failed, cancelled
    """

    def __init__(self, task_id: str, current_status: str, *args):
        self.task_id = task_id
        self.current_status = current_status
        message = f"Task {task_id} is already in terminal state: {current_status}"
        super().__init__(message, *args)


class CancellationTimeoutError(CancellationError):
    """Raised when cancellation takes too long.

    The task may or may not have been successfully cancelled.
    """

    def __init__(self, task_id: str, timeout_seconds: float, *args):
        self.task_id = task_id
        self.timeout_seconds = timeout_seconds
        message = f"Cancellation of task {task_id} timed out after {timeout_seconds}s"
        super().__init__(message, *args)
