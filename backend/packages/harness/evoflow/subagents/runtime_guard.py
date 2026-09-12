"""Helpers to correlate collab subtask rows with SubagentExecutor background tasks."""

from __future__ import annotations

from typing import Any

from evoflow.subagents.executor import SubagentStatus, get_background_task_result


def collab_subtask_lease_seconds(timeout_seconds: int | float) -> float:
    """Heartbeat lease for collab detached subagents (watchdog uses lease_until_ts)."""
    try:
        t = float(timeout_seconds)
    except (TypeError, ValueError):
        t = 600.0
    # Subagents often run several minutes; short leases caused false watchdog timeouts.
    # Minimum 300s (5 min) because tool calls can take 30-60s each; a worker doing
    # 5 consecutive reads without calling subtask_progress_report should not be killed.
    return max(300.0, min(900.0, t * 0.5))


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


__all__ = ["collab_subtask_lease_seconds", "is_subtask_background_executor_active"]
