"""Main scheduler manager — the orchestrator for automation tasks.

Manages the full lifecycle:
1. Load active automations from TOML storage
2. Parse schedules and calculate next triggers
3. Start/stop/cancel timers
4. Delegate execution to AutomationExecutor
5. Record run history

Roadmap: EVOFLOW_TOOLS_REFACTORING_ROADMAP.md #19 (远期规划)
"""

from __future__ import annotations

import atexit
import logging
import threading
from datetime import datetime

# Import sibling modules
from evoflow.core.scheduler.engine import (
    ScheduledTimer,
    SchedulerState,
    ScheduleType,
    next_trigger,
    parse_rrule,
    seconds_until,
)
from evoflow.core.scheduler.executor import (
    AutomationExecutor,
    RunRecord,
)
from evoflow.tools.builtins.automation_tool import (
    AutomationStatus,
    AutomationTask,
    _list_all_tasks,
    _load_task,
    _save_task,
)

logger = logging.getLogger(__name__)


class AutomationScheduler:
    """Central scheduler for all automation tasks.

    Usage::

        scheduler = AutomationScheduler()
        scheduler.start()  # Load and schedule all active tasks
        scheduler.stop()   # Graceful shutdown

    Thread-safe: all timer operations are protected by a lock.
    """

    def __init__(self, executor: AutomationExecutor | None = None):
        self._executor = executor or AutomationExecutor()
        self._state: SchedulerState = SchedulerState.STOPPED
        self._timers: dict[str, ScheduledTimer] = {}  # task_id -> Timer
        self._lock: threading.RLock = threading.RLock()
        self._started_at: datetime | None = None

    @property
    def state(self) -> SchedulerState:
        return self._state

    @property
    def is_running(self) -> bool:
        return self._state == SchedulerState.RUNNING

    @property
    def active_count(self) -> int:
        with self._lock:
            return sum(1 for t in self._timers.values() if t.is_running)

    def start(self) -> None:
        """Load all ACTIVE automations and start their timers."""
        if self._state == SchedulerState.RUNNING:
            logger.warning("Scheduler already running")
            return

        with self._lock:
            self._state = SchedulerState.RUNNING
            self._started_at = datetime.now()

            tasks = _list_all_tasks(status_filter=AutomationStatus.ACTIVE.value)
            loaded = 0
            for task in tasks:
                try:
                    self._schedule_task(task)
                    loaded += 1
                except Exception as e:
                    logger.error("Failed to schedule %s (%s): %s", task.id, task.name, e)

            logger.info(
                "Scheduler started: %d/%d active tasks scheduled",
                loaded,
                len(tasks),
            )

        # Register cleanup on exit
        atexit.register(self.stop)

    def stop(self) -> None:
        """Cancel all timers and stop scheduling."""
        if self._state == SchedulerState.STOPPED:
            return

        with self._lock:
            self._state = SchedulerState.STOPPED
            cancelled = 0
            for task_id, timer in list(self._timers.items()):
                if timer.cancel():
                    cancelled += 1
            self._timers.clear()

        logger.info(
            "Scheduler stopped (cancelled %d timers, uptime: %s)",
            cancelled,
            str(datetime.now() - self._started_at) if self._started_at else "N/A",
        )

    def pause(self, task_id: str) -> bool:
        """Pause a specific task's timer. Returns True if was running."""
        with self._lock:
            timer = self._timers.get(task_id)
            if timer and timer.cancel():
                # Also update persisted status
                task = _load_task(task_id)
                if task and task.status == AutomationStatus.ACTIVE.value:
                    task.status = AutomationStatus.PAUSED.value
                    _save_task(task)
                return True
        return False

    def resume(self, task_id: str) -> bool:
        """Resume a paused task. Returns True if successfully rescheduled."""
        task = _load_task(task_id)
        if not task or task.status != AutomationStatus.PAUSED.value:
            return False

        task.status = AutomationStatus.ACTIVE.value
        _save_task(task)

        with self._lock:
            return self._schedule_task(task)

    def trigger_now(self, task_id: str) -> RunRecord | None:
        """Manually trigger a task immediately (regardless of schedule)."""
        task = _load_task(task_id)
        if not task:
            return None

        workspace = task.cwds[0] if task.cwds else None
        record = self._executor.execute(
            task_id=task.id,
            task_name=task.name,
            prompt=task.prompt,
            workspace=workspace,
            manual=True,
        )

        # Update task stats
        task.last_run = record.finished_at
        task.last_status = record.status
        task.run_count += 1
        _save_task(task)

        return record

    def get_history(self, task_id: str, limit: int = 50) -> list[RunRecord]:
        """Get execution history for a task."""
        return self._executor.get_history(task_id, limit)

    def get_status_summary(self) -> dict:
        """Get overall scheduler status summary."""
        with self._lock:
            active_timers = sum(1 for t in self._timers.values() if t.is_running)

        tasks = _list_all_tasks()
        by_status: dict[str, int] = {}
        for t in tasks:
            by_status[t.status] = by_status.get(t.status, 0) + 1

        return {
            "scheduler_state": self._state.value,
            "active_timers": active_timers,
            "total_tasks": len(tasks),
            "by_status": by_status,
            "uptime_seconds": ((datetime.now() - self._started_at).total_seconds() if self._started_at else 0),
        }

    # ── Internal methods ──────────────────────────────────────────

    def _schedule_task(self, task: AutomationTask) -> bool:
        """Parse task's RRULE and set up its next timer.

        Called under lock.
        """
        parsed = parse_rrule(task.rrule)

        # For ONCE tasks, use scheduled_at
        if parsed.schedule_type == ScheduleType.ONCE and task.scheduled_at:
            try:
                parsed.target_time = datetime.fromisoformat(task.scheduled_at.replace("Z", "+00:00"))
            except ValueError:
                logger.warning("Invalid scheduled_at '%s' for %s: %e", task.scheduled_at, task.id)
                return False

        nxt = next_trigger(parsed)
        if nxt is None:
            logger.warning("No next trigger for %s (%s)", task.id, task.name)
            return False

        delay_secs = seconds_until(nxt)
        if delay_secs <= 0:
            # Trigger almost-immediately
            delay_secs = 0.5

        timer = ScheduledTimer(task_id=task.id)
        timer.start(delay_secs, callback=self._on_timer_fire)

        # Cancel existing timer for this task
        old = self._timers.get(task.id)
        if old and old.is_running:
            old.cancel()

        self._timers[task.id] = timer
        logger.debug(
            "Scheduled %s (%s): fires in %.0fs at %s",
            task.id,
            task.name,
            delay_secs,
            nxt.isoformat(),
        )
        return True

    def _on_timer_fire(self, task_id: str) -> None:
        """Callback when a timer fires — execute the task and reschedule."""
        task = _load_task(task_id)
        if not task:
            logger.warning("Timer fired but task %s not found", task_id)
            return

        # Check validity window
        now = datetime.now()
        valid = True
        if task.valid_from:
            try:
                if now < datetime.fromisoformat(task.valid_from):
                    valid = False
            except ValueError:
                pass
        if task.valid_until:
            try:
                if now > datetime.fromisoformat(task.valid_until):
                    valid = False
                    # Auto-complete expired recurring tasks
                    if task.schedule_type != "once":
                        task.status = AutomationStatus.COMPLETED.value
                        _save_task(task)
                        logger.info("Auto-completed expired task %s", task.id)
                        return
            except ValueError:
                pass

        if not valid or task.status != AutomationStatus.ACTIVE.value:
            logger.debug("Skipping %s: status=%s valid=%s", task.id, task.status, valid)
            # Reschedule even if skipped (for recurring tasks that may become valid later)
            if task.schedule_type != "once":
                self._reschedule(task)
            return

        # Execute
        workspace = task.cwds[0] if task.cwds else None
        record = self._executor.execute(
            task_id=task.id,
            task_name=task.name,
            prompt=task.prompt,
            workspace=workspace,
            manual=False,
        )

        # Update task stats
        task.last_run = record.finished_at
        task.last_status = record.status
        task.run_count += 1
        _save_task(task)

        # Reschedule for recurring tasks
        if task.schedule_type == "once":
            # Mark completed
            task.status = AutomationStatus.COMPLETED.value
            _save_task(task)
            logger.info("One-time task %s completed", task.id)
        else:
            self._reschedule(task)

    def _reschedule(self, task: AutomationTask) -> None:
        """Reschedule a recurring task after execution."""
        with self._lock:
            if self._state != SchedulerState.RUNNING:
                return
            try:
                self._schedule_task(task)
            except Exception as e:
                logger.error("Failed to reschedule %s: %s", task.id, e)


# ─── Global singleton ─────────────────────────────────────────────

_scheduler_instance: AutomationScheduler | None = None
_scheduler_lock = threading.Lock()


def get_scheduler() -> AutomationScheduler:
    """Get or create the global scheduler singleton."""
    global _scheduler_instance
    with _scheduler_lock:
        if _scheduler_instance is None:
            _scheduler_instance = AutomationScheduler()
        return _scheduler_instance


def start_global_scheduler() -> AutomationScheduler:
    """Start the global scheduler. Safe to call multiple times."""
    sched = get_scheduler()
    if not sched.is_running:
        sched.start()
    return sched


def stop_global_scheduler() -> None:
    """Stop the global scheduler."""
    global _scheduler_instance
    with _scheduler_lock:
        if _scheduler_instance is not None:
            _scheduler_instance.stop()
