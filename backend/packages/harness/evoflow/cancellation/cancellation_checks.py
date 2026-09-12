"""Cancellation check utilities.

Provides decorators and context managers for cooperative cancellation checks.
"""

import functools
import logging
from collections.abc import Callable
from contextlib import contextmanager
from typing import TypeVar

from .exceptions import TaskCancelledError
from .task_cancellation import is_task_cancelled

logger = logging.getLogger(__name__)

T = TypeVar("T")


def check_cancellation(task_id: str, message: str = "") -> None:
    """Check if a task has been cancelled and raise exception if so.

    This is the basic cancellation check that should be called at key points
    during task execution.

    Args:
        task_id: Task ID to check
        message: Optional custom message for the exception

    Raises:
        TaskCancelledError: If task has been cancelled
    """
    if is_task_cancelled(task_id):
        error_msg = message or f"Task {task_id} has been cancelled"
        logger.debug(f"Cancellation check triggered for task {task_id}")
        raise TaskCancelledError(task_id, error_msg)


def check_cancellation_decorator(task_id_getter: Callable[..., str]) -> Callable:
    """Decorator factory: check cancellation before function execution.

    Args:
        task_id_getter: Callable that extracts task_id from function arguments

    Returns:
        Decorator function

    Example:
        @check_cancellation_decorator(lambda self, *args: self.task_id)
        def execute_step(self, step):
            # Will raise TaskCancelledError if task is cancelled
            pass
    """

    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(func)
        def wrapper(*args, **kwargs) -> T:
            task_id = task_id_getter(*args, **kwargs)
            if task_id:
                check_cancellation(task_id)
            return func(*args, **kwargs)

        return wrapper

    return decorator


@contextmanager
def cancellation_check_context(task_id: str, interval: int = 1):
    """Context manager that checks cancellation on entry and periodically.

    Args:
        task_id: Task ID to monitor
        interval: Check interval in number of iterations (default: 1 = every time)

    Yields:
        None

    Raises:
        TaskCancelledError: If task is cancelled

    Example:
        with cancellation_check_context(task_id, interval=10):
            for item in large_dataset:
                process(item)  # Cancellation checked every 10 items
    """
    check_cancellation(task_id)

    counter = [0]  # Use list for mutable closure

    class CheckPoint:
        """Helper class to periodically check cancellation."""

        def check(self):
            counter[0] += 1
            if counter[0] % interval == 0:
                check_cancellation(task_id)

    yield CheckPoint()


class PeriodicCancellationChecker:
    """Periodic cancellation checker for long-running operations.

    Usage:
        checker = PeriodicCancellationChecker(task_id, interval_sec=5.0)
        for item in items:
            checker.check()  # Will raise if cancelled
            process(item)
    """

    def __init__(self, task_id: str, interval_sec: float = 5.0):
        """
        Args:
            task_id: Task ID to monitor
            interval_sec: Minimum interval between checks in seconds
        """
        self.task_id = task_id
        self.interval_sec = interval_sec
        self._last_check_time = 0.0

    def __enter__(self) -> "PeriodicCancellationChecker":
        return self

    def __exit__(self, *_exc: object) -> None:
        return None

    def check(self, force: bool = False) -> None:
        """Check cancellation if interval has passed.

        Args:
            force: Force check regardless of interval

        Raises:
            TaskCancelledError: If task is cancelled
        """
        import time

        current_time = time.time()

        if force or (current_time - self._last_check_time) >= self.interval_sec:
            check_cancellation(self.task_id)
            self._last_check_time = current_time


def check_cancellation_periodic(task_id: str, interval_sec: float = 5.0) -> PeriodicCancellationChecker:
    """Create a periodic cancellation checker.

    Args:
        task_id: Task ID to monitor
        interval_sec: Check interval in seconds

    Returns:
        PeriodicCancellationChecker instance
    """
    return PeriodicCancellationChecker(task_id, interval_sec)


def with_cancellation_retry(max_retries: int = 3, retry_delay: float = 1.0, on_cancelled: Callable[[str], None] | None = None):
    """Decorator factory: retry function if cancelled, then re-raise.

    This is useful for cleanup operations that should be attempted
    even if the task is cancelled.

    Args:
        max_retries: Maximum number of retries
        retry_delay: Delay between retries in seconds
        on_cancelled: Optional callback when cancelled

    Returns:
        Decorator function
    """

    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(func)
        def wrapper(*args, **kwargs) -> T:
            import time

            last_exception = None
            for attempt in range(max_retries + 1):
                try:
                    return func(*args, **kwargs)
                except TaskCancelledError as e:
                    last_exception = e
                    if on_cancelled:
                        try:
                            on_cancelled(e.task_id)
                        except Exception:
                            pass

                    if attempt < max_retries:
                        logger.debug(f"Task {e.task_id} cancelled, retrying {attempt + 1}/{max_retries}")
                        time.sleep(retry_delay)
                    else:
                        raise

            # Should never reach here
            if last_exception:
                raise last_exception
            return None  # type: ignore

        return wrapper

    return decorator
