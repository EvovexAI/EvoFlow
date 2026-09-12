"""Tests for subagent runtime guard helpers."""

from __future__ import annotations

from evoflow.subagents.executor import SubagentResult, SubagentStatus, _background_tasks, _background_tasks_lock
from evoflow.subagents.runtime_guard import collab_subtask_lease_seconds, is_subtask_background_executor_active


def test_collab_subtask_lease_seconds_minimum() -> None:
    assert collab_subtask_lease_seconds(60) >= 180.0
    assert collab_subtask_lease_seconds(900) == 450.0


def test_is_subtask_background_executor_active_running() -> None:
    task_id = "SupervisorExec_test_guard"
    with _background_tasks_lock:
        _background_tasks[task_id] = SubagentResult(task_id=task_id, trace_id="t", status=SubagentStatus.RUNNING)
    try:
        assert is_subtask_background_executor_active({"background_task_id": task_id}) is True
        assert is_subtask_background_executor_active({"background_task_id": "missing"}) is False
    finally:
        with _background_tasks_lock:
            _background_tasks.pop(task_id, None)
