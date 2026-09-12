"""Application timestamps (Asia/Shanghai, UTC+8)."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

BEIJING_TZ = ZoneInfo("Asia/Shanghai")


def beijing_now_iso() -> str:
    """Current instant as ISO-8601 in Beijing time (``+08:00``)."""
    return datetime.now(BEIJING_TZ).isoformat(timespec="microseconds")


def utc_now_iso_z() -> str:
    """Persisted / API-facing ``now`` (Beijing local time, with ``+08:00`` suffix).

    .. note::
       Despite the ``utc`` / ``Z`` name, this returns **Asia/Shanghai** time
       (UTC+8) with a ``+08:00`` timezone suffix.  Historical callers rely on
       the name, so it is kept for backward compatibility.
    """
    return beijing_now_iso()


def instant_to_beijing_iso(value: int | float | None) -> str:
    """Epoch milliseconds → Beijing ISO string."""
    if value is None:
        return ""
    try:
        ms = int(value)
    except (TypeError, ValueError):
        return ""
    if ms <= 0:
        return ""
    return datetime.fromtimestamp(ms / 1000.0, tz=BEIJING_TZ).isoformat(timespec="microseconds")


def unix_to_beijing_iso(value: float | int | None) -> str:
    if value is None:
        return ""
    try:
        sec = float(value)
    except (TypeError, ValueError):
        return ""
    if sec <= 0:
        return ""
    return datetime.fromtimestamp(sec, tz=BEIJING_TZ).isoformat(timespec="microseconds")


def parse_iso_to_ms(value: str | None) -> int:
    """Parse ISO timestamp (``Z``, ``+08:00``, or legacy bare) → epoch ms.

    Bare (timezone-naive) strings are assumed to be **Asia/Shanghai** (UTC+8)
    so that legacy data written before timestamps carried a suffix is still
    interpreted correctly.
    """
    raw = str(value or "").strip()
    if not raw:
        return 0
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        # Bare strings (no timezone info) → assume Beijing time
        if "+" not in raw and "-" not in raw[10:]:
            raw += "+08:00"
        return int(datetime.fromisoformat(raw).timestamp() * 1000)
    except (TypeError, ValueError):
        return 0


def parse_iso_to_unix(value: str | None) -> float:
    ms = parse_iso_to_ms(value)
    return ms / 1000.0 if ms > 0 else 0.0
