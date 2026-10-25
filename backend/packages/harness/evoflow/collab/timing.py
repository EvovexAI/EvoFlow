"""Task timing metrics — turn timestamps into queryable durations.

Design: ``docs/design/task-timing-metrics.md``.

Principles
----------
* **Timestamps are the truth, durations are a projection.** ``started_at`` /
  ``completed_at`` remain the SSOT; ``*_duration_ms`` are derived at write time
  so they can be indexed and aggregated, and can always be recomputed.
* **Three segments, never conflated:**

  ============  =========================  ===========================
  segment       span                       answers
  ============  =========================  ===========================
  ``wait``      created_at → started_at    queued? blocked on upstream?
  ``exec``      started_at → completed_at  how long the worker really ran
  ``total``     created_at → completed_at  what the user perceived
  ============  =========================  ===========================

  Collapsing them produces wrong conclusions: in practice a workflow step
  showed a 15.8 s "wait" that was purely a dependency wait, not scheduler lag.
* **Only trustworthy terminal rows count.** Cancelled / interrupted / healed
  rows are stamped ``unreliable`` so aggregates can exclude them instead of
  being skewed by residual timestamps. A cancelled run was once recorded as a
  15-hour node duration purely from leftover stamps.

Timing states
-------------
``ok``          finished normally; durations are trustworthy
``unreliable``  cancelled / interrupted / zombie-healed; durations are residue
``open``        not finished yet; no duration computed
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)

TIMING_OK = "ok"
TIMING_UNRELIABLE = "unreliable"
TIMING_OPEN = "open"

# Terminal states whose elapsed time is genuinely the work duration.
_TRUSTED_TERMINAL = frozenset({"completed", "success", "succeeded", "done"})
# Terminal states where elapsed time is leftover bookkeeping, not work.
_UNTRUSTED_TERMINAL = frozenset({"cancelled", "canceled", "interrupted", "paused"})
_FAILED_TERMINAL = frozenset({"failed", "error", "timed_out"})


def parse_iso_ts(raw: Any) -> float | None:
    """Parse an ISO-8601 stamp (``Z`` or offset aware) into unix seconds."""
    s = str(raw or "").strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s).timestamp()
    except Exception:
        return None


def _delta_ms(start: Any, end: Any) -> int | None:
    """Milliseconds between two stamps; ``None`` when either is missing/invalid."""
    a = parse_iso_ts(start)
    b = parse_iso_ts(end)
    if a is None or b is None:
        return None
    ms = int(round((b - a) * 1000.0))
    # Negative deltas mean clock skew / bad data — refuse rather than emit noise.
    return ms if ms >= 0 else None


def _resolve_state(
    status: str,
    *,
    exec_ms: int | None,
    stale_min_ms: int = 0,
) -> str:
    st = str(status or "").strip().lower()
    if st in _TRUSTED_TERMINAL:
        # A finished-but-absurdly-long row usually means it was resumed after a
        # long pause, not that work actually took that long.
        if exec_ms is not None and stale_min_ms and exec_ms > stale_min_ms:
            return TIMING_UNRELIABLE
        return TIMING_OK
    if st in _FAILED_TERMINAL:
        # Failures still carry a meaningful duration (how long until it broke).
        return TIMING_OK if exec_ms is not None else TIMING_OPEN
    if st in _UNTRUSTED_TERMINAL:
        return TIMING_UNRELIABLE
    return TIMING_OPEN


def _long_run_guard_ms() -> int:
    """Durations above this are treated as unreliable residue.

    Default 24h: a single workflow step taking longer means the row sat across a
    pause/resume or a crash, so the elapsed span is not real work time.
    """
    import os

    raw = str(os.getenv("EVOFLOW_TIMING_UNRELIABLE_MS") or "").strip()
    try:
        if raw:
            return max(0, int(float(raw)))
    except ValueError:
        pass
    return 24 * 60 * 60 * 1000


def subtask_timing_fields(row: dict[str, Any]) -> dict[str, Any]:
    """Compute ``wait_duration_ms`` / ``exec_duration_ms`` / ``timing_state``.

    Returns only the fields to merge into the row (never mutates the input).
    """
    if not isinstance(row, dict):
        return {}
    created = row.get("created_at")
    started = row.get("started_at")
    completed = row.get("completed_at")
    exec_ms = _delta_ms(started, completed)
    wait_ms = _delta_ms(created, started)
    state = _resolve_state(
        str(row.get("status") or ""),
        exec_ms=exec_ms,
        stale_min_ms=_long_run_guard_ms(),
    )
    # A row that never started has no wait/exec segment at all.
    if state == TIMING_OPEN and exec_ms is None:
        wait_ms = wait_ms if wait_ms is not None else None
    return {
        "wait_duration_ms": wait_ms,
        "exec_duration_ms": exec_ms,
        "timing_state": state,
    }


def run_timing_fields(run: dict[str, Any], *, task_status: str | None = None) -> dict[str, Any]:
    """Compute ``queue_ms`` / ``duration_ms`` / ``timing_state`` for an app run."""
    if not isinstance(run, dict):
        return {}
    created = run.get("created_at")
    started = run.get("started_at")
    completed = run.get("completed_at")
    duration_ms = _delta_ms(created, completed)
    queue_ms = _delta_ms(created, started)
    # The run's own status wins; the linked task status is a fallback used when
    # the run row has not been synced yet (cancelled upstream, etc.).
    status = str(run.get("status") or "").strip() or str(task_status or "").strip()
    state = _resolve_state(
        status,
        exec_ms=duration_ms,
        stale_min_ms=_long_run_guard_ms(),
    )
    return {
        "queue_ms": queue_ms,
        "duration_ms": duration_ms,
        "timing_state": state,
    }


def stamp_subtask_row(row: dict[str, Any]) -> bool:
    """Merge timing fields onto a subtask row in place. Returns ``True`` if changed."""
    fields = subtask_timing_fields(row)
    if not fields:
        return False
    changed = False
    for key, value in fields.items():
        if row.get(key) != value:
            row[key] = value
            changed = True
    return changed


def stamp_subtask_rows(rows: Any) -> int:
    """Stamp many subtask rows; returns how many changed."""
    n = 0
    for row in rows or []:
        if isinstance(row, dict) and stamp_subtask_row(row):
            n += 1
    return n


def format_duration_ms(ms: Any) -> str:
    """Human string for durations (``1m23s`` / ``15.4s``), shared with the UI."""
    try:
        value = float(ms)
    except (TypeError, ValueError):
        return ""
    if value < 0:
        return ""
    if value < 1000:
        return f"{int(value)}ms"
    seconds = value / 1000.0
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes, sec = divmod(int(round(seconds)), 60)
    if minutes < 60:
        return f"{minutes}m{sec:02d}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h{minutes:02d}m"


__all__ = [
    "TIMING_OK",
    "TIMING_OPEN",
    "TIMING_UNRELIABLE",
    "format_duration_ms",
    "parse_iso_ts",
    "run_timing_fields",
    "stamp_subtask_row",
    "stamp_subtask_rows",
    "subtask_timing_fields",
]
