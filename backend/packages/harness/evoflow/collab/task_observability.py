"""Aggregate per-task observability from ``evoflow_observability.db`` (by thread_id)."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from evoflow.collab.thread_ids import (
    collab_subtask_executor_thread_id,
    normalize_collab_executor_thread_id,
    normalize_lead_thread_id,
)
from evoflow.observability import queries as obs_queries

_TERMINAL_TASK_STATUSES = frozenset(
    {"completed", "failed", "cancelled", "canceled", "done", "success", "error", "timed_out"}
)
_ACTIVE_TASK_STATUSES = frozenset(
    {"executing", "running", "in_progress", "planning", "planned", "awaiting_exec", "plan_ready", "paused", "pending"}
)
_TERMINAL_SUBTASK_STATUSES = _TERMINAL_TASK_STATUSES | frozenset({"skipped"})
_ACTIVE_SUBTASK_STATUSES = frozenset({"executing", "running", "in_progress", "active", "working"})


def _extra_json_dict(subtask: dict[str, Any]) -> dict[str, Any]:
    raw = subtask.get("extra_json")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip().startswith("{"):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except (json.JSONDecodeError, TypeError):
            return {}
    return {}


def resolve_subtask_thread_id(task: dict[str, Any], sub: dict[str, Any]) -> str | None:
    """Executor thread for one subtask row."""
    lead = normalize_lead_thread_id(
        str(task.get("thread_id") or task.get("current_execution_thread_id") or "").strip()
    ) or ""
    sid = str(sub.get("id") or "").strip()
    extra = _extra_json_dict(sub)
    stored = str(
        sub.get("subtask_thread_id")
        or sub.get("external_session_id")
        or extra.get("subtask_thread_id")
        or extra.get("external_session_id")
        or ""
    ).strip()
    if stored:
        return normalize_collab_executor_thread_id(stored)
    if lead and sid:
        return collab_subtask_executor_thread_id(lead, sid)
    return None


def collect_task_thread_ids(task: dict[str, Any] | None) -> list[str]:
    """All LangGraph / collab thread ids associated with a main task (lead + subtasks + history)."""
    if not task or not isinstance(task, dict):
        return []
    seen: set[str] = set()
    out: list[str] = []

    def _add(raw: str | None) -> None:
        tid = normalize_collab_executor_thread_id(str(raw or "").strip())
        if not tid or tid in seen:
            return
        seen.add(tid)
        out.append(tid)

    lead = normalize_lead_thread_id(
        str(task.get("thread_id") or task.get("current_execution_thread_id") or "").strip()
    ) or ""
    if lead:
        _add(lead)

    for hist in task.get("execution_history") or []:
        if not isinstance(hist, dict):
            continue
        _add(str(hist.get("thread_id") or "").strip())

    for sub in task.get("subtasks") or []:
        if not isinstance(sub, dict):
            continue
        tid = resolve_subtask_thread_id(task, sub)
        if tid:
            _add(tid)

    return out


def _resolve_lead_thread_id(task: dict[str, Any]) -> str | None:
    lead = normalize_lead_thread_id(
        str(task.get("thread_id") or task.get("current_execution_thread_id") or "").strip()
    )
    return lead or None


def _parse_iso_ts(raw: Any) -> datetime | None:
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt
    except (ValueError, TypeError):
        return None


def _duration_fields(start_raw: Any, end_raw: Any, *, running: bool) -> dict[str, Any]:
    start = _parse_iso_ts(start_raw)
    if start is None:
        return {"duration_ms": None, "duration_running": False}
    end = _parse_iso_ts(end_raw)
    if end is None and running:
        end = datetime.now(UTC)
    if end is None:
        return {"duration_ms": None, "duration_running": False}
    delta_ms = max(0, int((end - start).total_seconds() * 1000))
    return {
        "duration_ms": delta_ms,
        "duration_running": bool(running and not str(end_raw or "").strip()),
        "duration_started_at": str(start_raw).strip() if start_raw else None,
        "duration_ended_at": str(end_raw).strip() if end_raw else None,
    }


def resolve_task_duration(task: dict[str, Any] | None) -> dict[str, Any]:
    """Wall-clock task duration from task-row timestamps (not observability DB)."""
    if not task or not isinstance(task, dict):
        return {"duration_ms": None, "duration_running": False}
    status = str(task.get("status") or "").strip().lower()
    terminal = status in _TERMINAL_TASK_STATUSES
    running = not terminal and (not status or status in _ACTIVE_TASK_STATUSES)

    if terminal:
        try:
            sec = float(task.get("execution_duration_seconds"))
            if sec >= 0:
                return {
                    "duration_ms": int(sec * 1000),
                    "duration_running": False,
                    "duration_started_at": task.get("execution_started_at") or task.get("started_at"),
                    "duration_ended_at": task.get("completed_at"),
                }
        except (TypeError, ValueError):
            pass

    start = (
        task.get("execution_started_at")
        or task.get("started_at")
        or task.get("planning_started_at")
        or task.get("created_at")
    )
    end = task.get("completed_at")
    return _duration_fields(start, end, running=running and not end)


def resolve_subtask_duration(sub: dict[str, Any]) -> dict[str, Any]:
    """Wall-clock subtask duration from subtask-row timestamps."""
    if not sub or not isinstance(sub, dict):
        return {"duration_ms": None, "duration_running": False}
    status = str(sub.get("status") or "").strip().lower()
    terminal = status in _TERMINAL_SUBTASK_STATUSES
    running = not terminal and status in _ACTIVE_SUBTASK_STATUSES
    start = sub.get("started_at") or sub.get("created_at")
    end = sub.get("completed_at")
    return _duration_fields(start, end, running=running and not end)


def summarize_task_observability(
    task_id: str,
    task: dict[str, Any] | None,
    *,
    since_hours: float | None = None,
) -> dict[str, Any]:
    """Task-level metrics from observability SQLite (no task-row retry fields)."""
    tid = str(task_id or "").strip()
    thread_ids = collect_task_thread_ids(task)
    by_thread = obs_queries.fetch_observability_breakdown_by_thread(
        thread_ids,
        since_hours=since_hours,
    )
    metrics = obs_queries.fetch_task_observability_metrics(
        thread_ids,
        main_task_id=tid,
        since_hours=since_hours,
        by_thread=by_thread,
    )

    lead_thread = _resolve_lead_thread_id(task) if task else None
    lead_metrics = by_thread.get(lead_thread or "", obs_queries.empty_thread_observability_metrics())
    if lead_thread:
        lead_metrics = {**lead_metrics, "thread_id": lead_thread}

    subtask_rows: list[dict[str, Any]] = []
    if task:
        for sub in task.get("subtasks") or []:
            if not isinstance(sub, dict):
                continue
            sid = str(sub.get("id") or "").strip()
            if not sid:
                continue
            st_thread = resolve_subtask_thread_id(task, sub)
            row_metrics = by_thread.get(st_thread or "", obs_queries.empty_thread_observability_metrics())
            subtask_rows.append(
                {
                    "subtask_id": sid,
                    "name": str(sub.get("name") or "").strip() or sid,
                    "thread_id": st_thread,
                    **resolve_subtask_duration(sub),
                    **row_metrics,
                }
            )

    task_duration = resolve_task_duration(task) if task else {"duration_ms": None, "duration_running": False}

    return {
        "success": True,
        "task_id": tid,
        "thread_ids": thread_ids,
        "lead": lead_metrics if lead_thread else None,
        "subtasks": subtask_rows,
        **task_duration,
        **metrics,
    }
