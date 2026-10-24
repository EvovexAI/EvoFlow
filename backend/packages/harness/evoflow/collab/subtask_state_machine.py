"""Subtask status transitions: one-way advance by default.

Opportunistic writers (task_tool start, peer wake, progress patches) must not
roll a terminal step back to an active status. Explicit retry / requeue paths
pass ``allow_terminal_downgrade=True``.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

TERMINAL_SUBTASK_STATUSES = frozenset(
    {"completed", "failed", "cancelled", "canceled", "timed_out", "done", "success"}
)
ACTIVE_SUBTASK_STATUSES = frozenset(
    {
        "pending",
        "planned",
        "executing",
        "running",
        "in_progress",
        "active",
        "waiting_dispatch",
        "planning",
        "paused",
    }
)

# Alias map → canonical status used for comparisons / writes.
_STATUS_ALIASES = {
    "done": "completed",
    "success": "completed",
    "canceled": "cancelled",
    "running": "executing",
    "active": "executing",
    "error": "failed",
    "timeout": "timed_out",
}


def normalize_subtask_status(raw: Any) -> str:
    s = str(raw or "").strip().lower()
    if not s:
        return "pending"
    return _STATUS_ALIASES.get(s, s)


def is_terminal_subtask_status(status: Any) -> bool:
    return normalize_subtask_status(status) in TERMINAL_SUBTASK_STATUSES or str(status or "").strip().lower() in TERMINAL_SUBTASK_STATUSES


def is_active_subtask_status(status: Any) -> bool:
    return normalize_subtask_status(status) in ACTIVE_SUBTASK_STATUSES or str(status or "").strip().lower() in ACTIVE_SUBTASK_STATUSES


def can_advance_subtask_status(
    from_status: Any,
    to_status: Any,
    *,
    allow_terminal_downgrade: bool = False,
) -> tuple[bool, str]:
    """Return whether ``from_status → to_status`` is allowed.

    Rules:
    - Empty / same (after normalize) → ok (no-op)
    - Terminal → active without ``allow_terminal_downgrade`` → rejected
    - Otherwise allowed (including terminal→terminal outcome changes when
      callers enforce their own outcome-report guards)
    """
    src_raw = str(from_status or "").strip().lower()
    dst_raw = str(to_status or "").strip().lower()
    if not dst_raw:
        return True, "no_status"
    src = normalize_subtask_status(src_raw)
    dst = normalize_subtask_status(dst_raw)
    if src == dst or src_raw == dst_raw:
        return True, "noop"
    src_terminal = src_raw in TERMINAL_SUBTASK_STATUSES or src in TERMINAL_SUBTASK_STATUSES
    dst_active = dst_raw in ACTIVE_SUBTASK_STATUSES or dst in ACTIVE_SUBTASK_STATUSES
    if src_terminal and dst_active and not allow_terminal_downgrade:
        return False, f"terminal_to_active:{src_raw or src}->{dst_raw or dst}"
    return True, "ok"


def filter_status_from_updates(
    old_status: Any,
    updates: dict[str, Any],
    *,
    allow_terminal_downgrade: bool = False,
    log_context: str = "",
) -> dict[str, Any]:
    """Return a copy of ``updates`` with illegal ``status`` stripped."""
    if "status" not in updates:
        return dict(updates)
    applied = dict(updates)
    new_status = applied.get("status")
    ok, reason = can_advance_subtask_status(
        old_status,
        new_status,
        allow_terminal_downgrade=allow_terminal_downgrade,
    )
    if ok:
        return applied
    logger.warning(
        "subtask_state_machine: refusing status update %s (%s)",
        reason,
        log_context or "-",
    )
    applied.pop("status", None)
    return applied


def advance_subtask_row_status(
    row: dict[str, Any],
    new_status: str,
    *,
    allow_terminal_downgrade: bool = False,
    progress: int | None = None,
) -> tuple[bool, str]:
    """Mutate ``row['status']`` (and optional progress) if the transition is legal.

    Returns ``(changed_or_applied, reason)``. When rejected, row is unchanged.
    """
    if not isinstance(row, dict):
        return False, "not_a_row"
    cur = str(row.get("status") or "").strip().lower()
    ok, reason = can_advance_subtask_status(
        cur,
        new_status,
        allow_terminal_downgrade=allow_terminal_downgrade,
    )
    if not ok:
        return False, reason
    canon = normalize_subtask_status(new_status)
    # Prefer writing canonical active/terminal names for common aliases.
    write = canon if canon in TERMINAL_SUBTASK_STATUSES | ACTIVE_SUBTASK_STATUSES else str(new_status).strip().lower()
    if write and write != cur:
        row["status"] = write
    if progress is not None:
        try:
            row["progress"] = max(0, min(100, int(progress)))
        except (TypeError, ValueError):
            pass
    return True, reason


__all__ = [
    "ACTIVE_SUBTASK_STATUSES",
    "TERMINAL_SUBTASK_STATUSES",
    "advance_subtask_row_status",
    "can_advance_subtask_status",
    "filter_status_from_updates",
    "is_active_subtask_status",
    "is_terminal_subtask_status",
    "normalize_subtask_status",
]
