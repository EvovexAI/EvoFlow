"""Event system for gateway API.

Provides lightweight in-memory event queue for decoupling API layer from Tool layer.
"""

from .event_queue import EventQueue, event_queue
from .task_event_handlers import handle_task_authorized, register_event_handlers
from .task_events import (
    TaskAuthorizedEvent,
    TaskExecutionFailedEvent,
    TaskExecutionStartedEvent,
    TaskResumeEvent,
)

__all__ = [
    "EventQueue",
    "event_queue",
    "TaskAuthorizedEvent",
    "TaskExecutionStartedEvent",
    "TaskExecutionFailedEvent",
    "TaskResumeEvent",
    "handle_task_authorized",
    "register_event_handlers",
]
