"""Proactive role schedule — same cron stack as automation tasks."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from evoflow.admin.automation_schedule import (
    cron_human_summary,
    cron_matches_at,
    cron_to_rrule,
    is_five_field_cron_or_keyword,
    next_cron_runs,
    rrule_to_cron,
)
from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
from evoflow.timeutil import BEIJING_TZ

# Default: every 2 hours during 09:00–19:59 (legacy HOURLY/2 + 9–20 window).
DEFAULT_HEARTBEAT_CRON = "0 9-19/2 * * *"

# Common legacy → cron examples (with default work window 09–20):
#   FREQ=HOURLY;INTERVAL=1  →  0 9-19 * * *
#   FREQ=HOURLY;INTERVAL=2  →  0 9-19/2 * * *
#   FREQ=MINUTELY;INTERVAL=30 → */30 9-19 * * *
# Without work window: INTERVAL=1 → 0 * * * * ; INTERVAL=2 → 0 */2 * * *


def _parse_rrule_parts(rrule: str) -> dict[str, str]:
    parts: dict[str, str] = {}
    for token in (rrule or "").strip().upper().split(";"):
        if "=" in token:
            k, v = token.split("=", 1)
            parts[k.strip()] = v.strip()
    return parts


def looks_like_legacy_rrule(value: str) -> bool:
    raw = (value or "").strip()
    if not raw or is_five_field_cron_or_keyword(raw):
        return False
    return "FREQ=" in raw.upper()


def legacy_rrule_to_cron(
    rrule: str,
    config: ProactiveRoleConfig | None = None,
) -> str:
    """Convert legacy RRULE (+ optional work-hours config) to 5-field cron."""
    raw = (rrule or "").strip()
    if is_five_field_cron_or_keyword(raw):
        return raw

    parts = _parse_rrule_parts(raw)
    freq = parts.get("FREQ", "HOURLY")
    try:
        interval = max(1, int(parts.get("INTERVAL", "1")))
    except ValueError:
        interval = 1
    try:
        hour = int(str(parts.get("BYHOUR", "9")).split(",")[0])
    except ValueError:
        hour = 9
    try:
        minute = int(str(parts.get("BYMINUTE", "0")).split(",")[0])
    except ValueError:
        minute = 0

    ws_enabled = config is None or getattr(config, "work_schedule_enabled", True)
    start = int(getattr(config, "work_start_hour", 9) if config else 9)
    end = int(getattr(config, "work_end_hour", 20) if config else 20)
    end_inclusive = max(start, end - 1) if end > start else 23

    if freq == "HOURLY":
        if ws_enabled and start < end:
            hour_field = (
                f"{start}-{end_inclusive}/{interval}" if interval > 1 else f"{start}-{end_inclusive}"
            )
            return f"{minute} {hour_field} * * *"
        return f"{minute} */{interval} * * *" if interval > 1 else f"{minute} * * * *"

    if freq == "MINUTELY":
        if ws_enabled and start < end:
            return f"*/{interval} {start}-{end_inclusive} * * *"
        return f"*/{interval} * * * *"

    if freq == "DAILY":
        return f"{minute} {hour} * * *"

    if freq == "WEEKLY":
        byday = parts.get("BYDAY", "MO")
        dow_map = {
            "SU": "0",
            "MO": "1",
            "TU": "2",
            "WE": "3",
            "TH": "4",
            "FR": "5",
            "SA": "6",
        }
        nums = ",".join(dow_map.get(d.strip(), "?") for d in byday.split(",") if d.strip())
        if nums and "?" not in nums:
            return f"{minute} {hour} * * {nums}"
        return f"{minute} {hour} * * 1"

    derived = rrule_to_cron(raw)
    if is_five_field_cron_or_keyword(derived):
        return derived
    return DEFAULT_HEARTBEAT_CRON


def migrate_stored_schedule(rrule: str, config_json: str) -> str:
    cfg = ProactiveRoleConfig.from_json(config_json)
    return legacy_rrule_to_cron(rrule, cfg)


def resolve_role_cron(role: ProactiveRole) -> str:
    """Authoritative cron: prefer heartbeat_schedule; else migrate legacy RRULE."""
    sched = str(getattr(role, "heartbeat_schedule", "") or "").strip()
    if is_five_field_cron_or_keyword(sched):
        return sched
    # Some installs stuffed RRULE into heartbeat_schedule before the column existed as cron.
    if looks_like_legacy_rrule(sched):
        return legacy_rrule_to_cron(sched, role.config)
    rrule = str(role.heartbeat_rrule or "").strip()
    if is_five_field_cron_or_keyword(rrule):
        return rrule
    return legacy_rrule_to_cron(rrule, role.config)


def sync_role_schedule_fields(role: ProactiveRole, cron_expr: str) -> None:
    """Persist authoritative cron on role and derive legacy RRULE for compat."""
    cron = str(cron_expr or "").strip()
    if not is_five_field_cron_or_keyword(cron):
        cron = DEFAULT_HEARTBEAT_CRON
    role.heartbeat_schedule = cron
    derived = cron_to_rrule(cron)
    role.heartbeat_rrule = str(derived.get("rrule") or cron)


def ensure_role_schedule_fields(role: ProactiveRole) -> bool:
    """Idempotent: normalize role to cron + derived RRULE. True if fields changed.

    Safe for installed users still on ``FREQ=HOURLY;INTERVAL=N`` — call from
    migration heal, save_role, and lazy load so DB catches up without a manual step.
    """
    before_s = str(getattr(role, "heartbeat_schedule", "") or "").strip()
    before_r = str(role.heartbeat_rrule or "").strip()
    sync_role_schedule_fields(role, resolve_role_cron(role))
    after_s = str(role.heartbeat_schedule or "").strip()
    after_r = str(role.heartbeat_rrule or "").strip()
    return after_s != before_s or after_r != before_r


def apply_schedule_input(
    role: ProactiveRole,
    *,
    heartbeat_schedule: str | None = None,
    heartbeat_rrule: str | None = None,
) -> bool:
    """Apply schedule from API payload. Returns True if schedule changed."""
    sched_in = str(heartbeat_schedule or "").strip()
    rrule_in = str(heartbeat_rrule or "").strip()
    prev = resolve_role_cron(role)

    if sched_in:
        if looks_like_legacy_rrule(sched_in):
            sync_role_schedule_fields(role, legacy_rrule_to_cron(sched_in, role.config))
        else:
            sync_role_schedule_fields(role, sched_in)
    elif rrule_in:
        sync_role_schedule_fields(role, legacy_rrule_to_cron(rrule_in, role.config))
    else:
        return False

    return resolve_role_cron(role) != prev


def _now_beijing(now: datetime | None = None) -> datetime:
    now_dt = now if isinstance(now, datetime) else datetime.now(BEIJING_TZ)
    if now_dt.tzinfo is None:
        return now_dt.replace(tzinfo=BEIJING_TZ)
    return now_dt.astimezone(BEIJING_TZ)


def _naive_local(dt: datetime) -> datetime:
    """Strip tz for cron helpers (local clock semantics)."""
    if dt.tzinfo is not None:
        return dt.astimezone().replace(tzinfo=None)
    return dt


def compute_next_duty_iso(role: ProactiveRole, *, now: Any | None = None) -> str:
    """Next auto-patrol time from cron (Beijing ISO).

    Always returns a time strictly after ``now`` when cron yields runs. If cron
    parsing fails (empty runs), fall back to +2h — never ``now``, or the runner
    would treat every role as immediately due on the next tick.
    """
    now_dt = _now_beijing(now if isinstance(now, datetime) else None)
    cron = resolve_role_cron(role)
    runs = next_cron_runs(cron, count=1, from_dt=_naive_local(now_dt))
    if runs:
        next_dt = runs[0].replace(tzinfo=BEIJING_TZ)
        if next_dt > now_dt:
            return next_dt.isoformat(timespec="microseconds")
    # Broken cron / empty scan — push out so we do not stampede on restart.
    return (now_dt + timedelta(hours=2)).isoformat(timespec="microseconds")


def compute_backoff_duty_iso(
    role: ProactiveRole,
    *,
    scale: int,
    now: Any | None = None,
) -> str:
    """Skip ahead in the cron series when consecutive no-ops trigger backoff."""
    now_dt = _now_beijing(now if isinstance(now, datetime) else None)
    cron = resolve_role_cron(role)
    count = max(1, int(scale or 1))
    runs = next_cron_runs(cron, count=count, from_dt=_naive_local(now_dt))
    if not runs:
        return compute_next_duty_iso(role, now=now_dt)
    pick = runs[min(count, len(runs)) - 1]
    return pick.replace(tzinfo=BEIJING_TZ).isoformat(timespec="microseconds")


def resolve_next_duty_display(role: ProactiveRole, *, now: Any | None = None) -> str:
    """Authoritative next-duty ISO for API: stored future value or fresh compute."""
    now_dt = _now_beijing(now if isinstance(now, datetime) else None)
    stored_raw = str(role.next_heartbeat_at or "").strip()
    if stored_raw:
        try:
            stored = datetime.fromisoformat(stored_raw.replace("Z", "+00:00"))
            if stored.tzinfo is None:
                stored = stored.replace(tzinfo=BEIJING_TZ)
            else:
                stored = stored.astimezone(BEIJING_TZ)
            if stored > now_dt:
                return stored.isoformat(timespec="microseconds")
        except Exception:
            pass
    return compute_next_duty_iso(role, now=now_dt)


def schedule_summary_for_role(role: ProactiveRole) -> str:
    return cron_human_summary(resolve_role_cron(role))


def cron_matches_role_now(role: ProactiveRole, when: datetime | None = None) -> bool:
    return cron_matches_at(resolve_role_cron(role), _naive_local(_now_beijing(when)))
