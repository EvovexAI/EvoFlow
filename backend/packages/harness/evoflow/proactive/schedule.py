"""Proactive role schedule — same cron stack as automation tasks."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from evoflow.admin.automation_schedule import (
    cron_csv_from_rrule_part,
    cron_human_summary,
    cron_matches_at,
    cron_to_rrule,
    is_five_field_cron_or_keyword,
    next_cron_runs,
    rrule_to_cron,
)
from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
from evoflow.timeutil import BEIJING_TZ

# Default: twice a day (09:00 & 15:00). Every-2h was too frequent for new hires.
DEFAULT_HEARTBEAT_CRON = "0 9,15 * * *"

# Explicit "no timed patrol" sentinel stored in ``heartbeat_schedule``.
# Role can stay active (chat / manual dispatch) without scheduler ticks.
SCHEDULE_OFF = "off"
_SCHEDULE_OFF_TOKENS = frozenset({"off", "never", "disabled", "none", "@never", "@off"})

# Common legacy → cron examples (with default work window 09–20):
#   FREQ=HOURLY;INTERVAL=1  →  0 9-19 * * *
#   FREQ=HOURLY;INTERVAL=2  →  0 9-19/2 * * *  (legacy; new default is twice daily)
#   FREQ=MINUTELY;INTERVAL=30 → */30 9-19 * * *
# Without work window: INTERVAL=1 → 0 * * * * ; INTERVAL=2 → 0 */2 * * *


def is_schedule_off(value: str | None) -> bool:
    """True when schedule means「关闭巡检 / 不开启定时巡检」."""
    return str(value or "").strip().lower() in _SCHEDULE_OFF_TOKENS


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
    # Keep every BYHOUR / BYMINUTE value: ``BYHOUR=9,15`` must derive to
    # ``0 9,15 * * *``. Taking split(",")[0] here silently dropped the second
    # patrol slot, so a role the user set to 09:00+15:00 ran 09:00 only.
    hour = cron_csv_from_rrule_part(parts.get("BYHOUR", "9"), lo=0, hi=23, default=9)
    minute = cron_csv_from_rrule_part(parts.get("BYMINUTE", "0"), lo=0, hi=59, default=0)

    ws_enabled = config is None or getattr(config, "work_schedule_enabled", True)
    start = int(getattr(config, "work_start_hour", 9) if config else 9)
    end = int(getattr(config, "work_end_hour", 20) if config else 20)
    end_inclusive = max(start, end - 1) if end > start else 23

    if freq == "HOURLY":
        if ws_enabled and start < end:
            hour_field = f"{start}-{end_inclusive}/{interval}" if interval > 1 else f"{start}-{end_inclusive}"
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
    """Authoritative cron: prefer heartbeat_schedule; else migrate legacy RRULE.

    Returns empty string when schedule is explicitly off (no timed patrol).
    """
    sched = str(getattr(role, "heartbeat_schedule", "") or "").strip()
    if is_schedule_off(sched):
        return ""
    if is_five_field_cron_or_keyword(sched):
        return sched
    # Some installs stuffed RRULE into heartbeat_schedule before the column existed as cron.
    if looks_like_legacy_rrule(sched):
        return legacy_rrule_to_cron(sched, role.config)
    rrule = str(role.heartbeat_rrule or "").strip()
    if is_schedule_off(rrule):
        return ""
    if is_five_field_cron_or_keyword(rrule):
        return rrule
    if looks_like_legacy_rrule(rrule):
        return legacy_rrule_to_cron(rrule, role.config)
    return DEFAULT_HEARTBEAT_CRON


def sync_role_schedule_fields(
    role: ProactiveRole,
    cron_expr: str,
    *,
    clear_suspend_latch: bool = True,
) -> None:
    """Persist authoritative cron on role and derive legacy RRULE for compat.

    ``clear_suspend_latch``: a real cron means「用户重新开了巡检」→ drop the
    suspend flag. Must stay True for explicit schedule writes (panel / API) and
    False for lazy heal paths — see ``ensure_role_schedule_fields``.
    """
    cron = str(cron_expr or "").strip()
    if is_schedule_off(cron):
        role.heartbeat_schedule = SCHEDULE_OFF
        role.heartbeat_rrule = ""
        role.next_heartbeat_at = None
        try:
            role.config.auto_patrol_suspended = True
        except Exception:
            pass
        return
    if not is_five_field_cron_or_keyword(cron):
        cron = DEFAULT_HEARTBEAT_CRON
    role.heartbeat_schedule = cron
    derived = cron_to_rrule(cron)
    role.heartbeat_rrule = str(derived.get("rrule") or cron)
    if not clear_suspend_latch:
        return
    try:
        # Re-enabling a real cron clears the "关闭巡检" suspend latch.
        role.config.auto_patrol_suspended = False
    except Exception:
        pass


def wire_role_schedule(role: ProactiveRole) -> str:
    """Value for API / UI: cron string, or ``off`` when timed patrol is disabled."""
    stored = str(getattr(role, "heartbeat_schedule", "") or "").strip()
    if is_schedule_off(stored):
        return SCHEDULE_OFF
    return resolve_role_cron(role)


def ensure_role_schedule_fields(role: ProactiveRole) -> bool:
    """Idempotent: normalize role to cron + derived RRULE. True if fields changed.

    Safe for installed users still on ``FREQ=HOURLY;INTERVAL=N`` — call from
    migration heal, save_role, and lazy load so DB catches up without a manual step.

    Never touches ``auto_patrol_suspended``: this runs on every ``save_role`` and
    on lazy reads, so clearing the latch here silently un-did ``roles.stop``
    (stopped employee looked active but patrol latch was gone / or was wiped and
    the role re-fired). Only an explicit schedule write re-arms patrol — see
    ``apply_schedule_input``.
    """
    before_s = str(getattr(role, "heartbeat_schedule", "") or "").strip()
    before_r = str(role.heartbeat_rrule or "").strip()
    if is_schedule_off(before_s) or is_schedule_off(before_r):
        sync_role_schedule_fields(role, SCHEDULE_OFF, clear_suspend_latch=False)
    else:
        sync_role_schedule_fields(
            role, resolve_role_cron(role), clear_suspend_latch=False
        )
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
    prev_off = is_schedule_off(str(getattr(role, "heartbeat_schedule", "") or ""))

    if is_schedule_off(sched_in):
        sync_role_schedule_fields(role, SCHEDULE_OFF)
    elif sched_in:
        if looks_like_legacy_rrule(sched_in):
            sync_role_schedule_fields(role, legacy_rrule_to_cron(sched_in, role.config))
        else:
            sync_role_schedule_fields(role, sched_in)
    elif rrule_in:
        if is_schedule_off(rrule_in):
            sync_role_schedule_fields(role, SCHEDULE_OFF)
        else:
            sync_role_schedule_fields(role, legacy_rrule_to_cron(rrule_in, role.config))
    else:
        return False

    now_off = is_schedule_off(str(getattr(role, "heartbeat_schedule", "") or ""))
    return resolve_role_cron(role) != prev or now_off != prev_off


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

    Schedule-off roles return empty string (no next tick).
    """
    cron = resolve_role_cron(role)
    if not cron:
        return ""
    now_dt = _now_beijing(now if isinstance(now, datetime) else None)
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
    cron = resolve_role_cron(role)
    if not cron:
        return ""
    now_dt = _now_beijing(now if isinstance(now, datetime) else None)
    count = max(1, int(scale or 1))
    runs = next_cron_runs(cron, count=count, from_dt=_naive_local(now_dt))
    if not runs:
        return compute_next_duty_iso(role, now=now_dt)
    pick = runs[min(count, len(runs)) - 1]
    return pick.replace(tzinfo=BEIJING_TZ).isoformat(timespec="microseconds")


def resolve_next_duty_display(role: ProactiveRole, *, now: Any | None = None) -> str:
    """Authoritative next-duty ISO for API: stored future value or fresh compute."""
    if not resolve_role_cron(role):
        return ""
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
    cron = resolve_role_cron(role)
    if not cron:
        return "关闭巡检"
    return cron_human_summary(cron)


def cron_matches_role_now(role: ProactiveRole, when: datetime | None = None) -> bool:
    cron = resolve_role_cron(role)
    if not cron:
        return False
    return cron_matches_at(cron, _naive_local(_now_beijing(when)))


def resolve_work_window(role: ProactiveRole) -> tuple[int, int] | None:
    """Return the ``(start_hour, end_hour)`` work window, or ``None`` when unlimited.

    ``work_schedule_enabled=False`` means「不受上班时间限制」. A window whose
    ``start >= end`` is treated as **overnight** (e.g. 22 → 6 = night shift) and
    is returned as-is so the caller can compare against the wrapped hour.
    """
    cfg = getattr(role, "config", None)
    if cfg is None:
        return None
    if not bool(getattr(cfg, "work_schedule_enabled", True)):
        return None
    start = int(getattr(cfg, "work_start_hour", 9) or 0)
    end = int(getattr(cfg, "work_end_hour", 20) or 0)
    start = max(0, min(23, start))
    end = max(0, min(23, end))
    if start == end:
        # Zero-length window → no hour is inside it; treat as unlimited so a
        # mis-typed value never silently freezes the employee.
        return None
    return (start, end)


def within_work_window(role: ProactiveRole, when: datetime | None = None) -> bool:
    """True when ``when`` (local clock) falls inside the role's work window.

    Mirrors the cron clock semantics used elsewhere: Beijing time projected onto
    the machine's local wall clock, hour granularity (``[start, end)``).
    """
    window = resolve_work_window(role)
    if window is None:
        return True
    start, end = window
    hour = _naive_local(_now_beijing(when)).hour
    if start < end:
        return start <= hour < end
    # Overnight window (start > end): e.g. 22–6 covers 22:00–05:59.
    return hour >= start or hour < end


def work_window_label_zh(role: ProactiveRole) -> str:
    """Human label for the role's work window (for skip reasons / UI)."""
    window = resolve_work_window(role)
    if window is None:
        return "不限上班时间"
    start, end = window
    if start < end:
        return f"上班时间 {start:02d}:00–{end:02d}:00"
    return f"上班时间 {start:02d}:00–次日{end:02d}:00"
