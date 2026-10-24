"""Helpers to correlate collab subtask rows with SubagentExecutor background tasks."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.subagents.executor import SubagentStatus, get_background_task_result

logger = logging.getLogger(__name__)

# Lightweight counters for ops (not a full metrics backend).
_lease_metrics: dict[str, int] = {"light": 0, "full": 0}


def lease_metrics_snapshot() -> dict[str, int]:
    """Return copy of lease-mode issuance counts (tests / diagnostics)."""
    return dict(_lease_metrics)


def collab_subtask_lease_seconds(
    timeout_seconds: int | float,
    *,
    reporting_mode: str = "full",
) -> float:
    """Heartbeat lease for collab detached subagents (watchdog uses lease_until_ts)."""
    try:
        t = float(timeout_seconds)
    except (TypeError, ValueError):
        t = 600.0
    # Light (App workflow): shorter lease — steps are short and outcome-only;
    # still ≥120s so a single slow model/tool round does not false-timeout.
    if str(reporting_mode or "").strip().lower() == "light":
        lease = max(120.0, min(300.0, t * 0.35))
        _lease_metrics["light"] = int(_lease_metrics.get("light") or 0) + 1
        logger.debug("collab_lease mode=light seconds=%.1f timeout=%.1f", lease, t)
        return lease
    # Full Lead collab: Subagents often run several minutes; short leases caused
    # false watchdog timeouts. Minimum 300s (5 min) because tool calls can take
    # 30-60s each; a worker doing 5 consecutive reads without calling
    # progress should not be killed.
    lease = max(300.0, min(900.0, t * 0.5))
    _lease_metrics["full"] = int(_lease_metrics.get("full") or 0) + 1
    return lease


def is_subtask_background_executor_active(subtask_row: dict[str, Any] | None) -> bool:
    """True when a detached task_tool run is still pending or running for this subtask row."""
    if not isinstance(subtask_row, dict):
        return False
    bg_id = str(subtask_row.get("background_task_id") or "").strip()
    if not bg_id:
        return False
    result = get_background_task_result(bg_id)
    if result is None:
        return False
    return result.status in {SubagentStatus.PENDING, SubagentStatus.RUNNING}


__all__ = [
    "collab_subtask_lease_seconds",
    "is_subtask_background_executor_active",
    "lease_metrics_snapshot",
]
