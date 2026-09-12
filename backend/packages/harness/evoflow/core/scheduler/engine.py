"""Lightweight scheduler engine for automation tasks.

Uses threading.Timer for zero-dependency scheduling with iCalendar
RRULE-like schedule parsing.

Roadmap: EVOFLOW_TOOLS_REFACTORING_ROADMAP.md #19 (远期规划)
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta

try:
    from enum import StrEnum
except ImportError:
    from enum import Enum

    class StrEnum(str, Enum):
        pass


logger = logging.getLogger(__name__)


# ─── Schedule types ─────────────────────────────────────────────


class ScheduleType(StrEnum):
    ONCE = "once"
    HOURLY = "hourly"
    DAILY = "daily"
    WEEKLY = "weekly"
    INTERVAL = "interval"  # Generic N-second interval


class SchedulerState(StrEnum):
    STOPPED = "stopped"
    RUNNING = "running"
    PAUSED = "paused"


# ─── RRULE parser (lightweight) ──────────────────────────────────


_RRULE_FREQ_MAP: dict[str, ScheduleType] = {
    "HOURLY": ScheduleType.HOURLY,
    "DAILY": ScheduleType.DAILY,
    "WEEKLY": ScheduleType.WEEKLY,
}

_DAY_ABBR_TO_NUM: dict[str, int] = {
    "MO": 0,
    "TU": 1,
    "WE": 2,
    "TH": 3,
    "FR": 4,
    "SA": 5,
    "SU": 6,
}


@dataclass  # type: ignore[misc]
class ParsedSchedule:
    """Result of parsing an RRULE or human-readable schedule."""

    schedule_type: ScheduleType
    interval_seconds: int | None = None  # For HOURLY/INTERVAL
    days_of_week: list[int] | None = None  # For WEEKLY (0=Mon)
    hour: int | None = None  # Hour of day (0-23)
    minute: int | None = None  # Minute of hour (0-59)
    target_time: datetime | None = None  # For ONCE


def parse_rrule(rrule_str: str) -> ParsedSchedule:
    """Parse an iCalendar RRULE-like string into a ParsedSchedule.

    Supports a subset sufficient for common use cases:
    - FREQ=HOURLY;INTERVAL=N
    - FREQ=DAILY;INTERVAL=N
    - FREQ=WEEKLY;BYDAY=MO,TU,...;BYHOUR=HH
    - Empty string treated as interval-only (use scheduled_at)
    """
    if not rrule_str or not rrule_str.strip():
        return ParsedSchedule(schedule_type=ScheduleType.INTERVAL, interval_seconds=None)

    parts: dict[str, str] = {}
    for segment in rrule_str.upper().split(";"):
        segment = segment.strip()
        if "=" in segment:
            key, _, val = segment.partition("=")
            parts[key.strip()] = val.strip()

    freq = parts.get("FREQ", "")
    interval = int(parts.get("INTERVAL", 1))
    byday = parts.get("BYDAY", "")
    byhour = parts.get("BYHOUR", "")

    stype = _RRULE_FREQ_MAP.get(freq, ScheduleType.INTERVAL)

    result = ParsedSchedule(schedule_type=stype)

    match stype:
        case ScheduleType.ONCE:
            pass  # Use scheduled_at from task data

        case ScheduleType.HOURLY:
            result.interval_seconds = interval * 3600

        case ScheduleType.DAILY:
            result.interval_seconds = interval * 86400
            if byhour:
                result.hour = int(byhour)

        case ScheduleType.WEEKLY:
            result.interval_seconds = interval * 7 * 86400
            if byday:
                days = []
                for d in byday.split(","):
                    d = d.strip()
                    if d in _DAY_ABBR_TO_NUM:
                        days.append(_DAY_ABBR_TO_NUM[d])
                result.days_of_week = sorted(days) or [0]
            if byhour:
                result.hour = int(byhour)

        case ScheduleType.INTERVAL:
            result.interval_seconds = max(interval, 60)  # Min 60s

        case _:
            result.interval_seconds = 3600  # Default hourly

    return result


def next_trigger(parsed: ParsedSchedule, base_time: datetime | None = None) -> datetime | None:
    """Calculate the next trigger time based on parsed schedule.

    Args:
        parsed: ParsedSchedule from parse_rrule().
        base_time: Reference time (defaults to now).

    Returns:
        Next trigger datetime, or None if no valid trigger.
    """
    now = base_time or datetime.now()

    match parsed.schedule_type:
        case ScheduleType.ONCE:
            return parsed.target_time

        case ScheduleType.HOURLY if parsed.interval_seconds is not None:
            # Round up to next interval boundary
            secs = parsed.interval_seconds
            elapsed = (now - datetime.now().replace(minute=0, second=0, microsecond=0)).total_seconds()
            wait_secs = secs - (elapsed % secs) if elapsed % secs != 0 else 0
            if wait_secs == 0:
                wait_secs = secs  # Already at boundary, next one
            return now + timedelta(seconds=wait_secs)

        case ScheduleType.DAILY:
            hour = parsed.hour if parsed.hour is not None else 9
            today_target = now.replace(hour=hour, minute=parsed.minute or 0, second=0, microsecond=0)
            if today_target > now:
                return today_target
            return today_target + timedelta(days=1)

        case ScheduleType.WEEKLY:
            hour = parsed.hour if parsed.hour is not None else 9
            dow_list = parsed.days_of_week or [0]

            # Find next matching weekday
            for offset in range(8):
                check = now + timedelta(days=offset)
                if check.weekday() in dow_list:
                    target = check.replace(hour=hour, minute=parsed.minute or 0, second=0, microsecond=0)
                    if target > now:
                        return target
            return None  # Shouldn't happen

        case _:
            secs = parsed.interval_seconds or 3600
            return now + timedelta(seconds=secs)


def seconds_until(target: datetime) -> float:
    """Return seconds until target time. Returns 0 if already passed."""
    delta = (target - datetime.now()).total_seconds()
    return max(delta, 0)


# ─── Timer wrapper ──────────────────────────────────────────────


@dataclass  # type: ignore[misc]
class ScheduledTimer:
    """A managed timer for a single automation trigger."""

    task_id: str
    timer: threading.Timer | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)

    def start(self, delay_seconds: float, callback) -> None:
        """Start the timer. Cancels any existing one first."""
        self.cancel()
        self.cancel_event.clear()
        self.timer = threading.Timer(delay_seconds, callback, args=(self.task_id,))
        self.timer.daemon = True
        self.timer.name = f"scheduler-{self.task_id}"
        self.timer.start()

    def cancel(self) -> bool:
        """Cancel the timer. Returns True if was running."""
        if self.timer and self.timer.is_alive():
            self.timer.cancel()
            self.cancel_event.set()
            return True
        self.timer = None
        return False

    @property
    def is_running(self) -> bool:
        return self.timer is not None and self.timer.is_alive()
