"""EvoFlow Scheduler — lightweight automation scheduling engine.

Modules:
- engine:   RRULE parser, next-trigger calculator, timer wrapper
- executor: Task execution engine with history recording
- manager:  Central orchestrator (singleton pattern)

Usage::

    from evoflow.core.scheduler import get_scheduler, start_global_scheduler

    # Start scheduling all active automations
    sched = start_global_scheduler()

    # Manually trigger a task
    record = sched.trigger_now("abc123")

    # Get status
    summary = sched.get_status_summary()
"""

from evoflow.core.scheduler.engine import (
    ParsedSchedule,
    ScheduledTimer,
    SchedulerState,
    ScheduleType,
    next_trigger,
    parse_rrule,
    seconds_until,
)
from evoflow.core.scheduler.executor import (
    AutomationExecutor,
    AutomationExecutorConfig,
    ExecutionStatus,
    RunRecord,
)
from evoflow.core.scheduler.manager import (
    AutomationScheduler,
    get_scheduler,
    start_global_scheduler,
    stop_global_scheduler,
)

__all__ = [
    # Engine
    "ParsedSchedule",
    "ScheduledTimer",
    "ScheduleType",
    "SchedulerState",
    "next_trigger",
    "parse_rrule",
    "seconds_until",
    # Executor
    "AutomationExecutor",
    "AutomationExecutorConfig",
    "ExecutionStatus",
    "RunRecord",
    # Manager
    "AutomationScheduler",
    "get_scheduler",
    "start_global_scheduler",
    "stop_global_scheduler",
]
