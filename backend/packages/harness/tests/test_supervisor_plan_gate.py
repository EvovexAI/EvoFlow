"""supervisor plan-collaboration gate returns errors from the tool, not plan_guard injection."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from evoflow.collab.supervisor_plan_gate import check_supervisor_collab_gate


@pytest.fixture(autouse=True)
def _strict_plan_active() -> None:
    with patch(
        "evoflow.collab.supervisor_plan_gate.is_strict_plan_collaboration_for_thread",
        return_value=True,
    ):
        yield


def test_create_task_without_plan_returns_need_plan_first() -> None:
    with patch(
        "evoflow.collab.supervisor_plan_gate.collaboration_has_committed_plan",
        return_value=False,
    ):
        out = check_supervisor_collab_gate("create_task", "thread-1")
    assert out is not None
    assert out["error_code"] == "need_plan_first"
    assert out["action"] == "create_task"


def test_start_execution_without_auth_returns_need_execution_authorization() -> None:
    with (
        patch(
            "evoflow.collab.supervisor_plan_gate.collaboration_has_committed_plan",
            return_value=True,
        ),
        patch(
            "evoflow.collab.supervisor_plan_gate.collaboration_has_execution_authorization",
            return_value=False,
        ),
    ):
        out = check_supervisor_collab_gate("start_execution", "thread-1")
    assert out is not None
    assert out["error_code"] == "need_execution_authorization"
    assert "待授权开始执行" in out["message"]


def test_complete_subtask_without_auth_gated() -> None:
    with (
        patch(
            "evoflow.collab.supervisor_plan_gate.collaboration_has_committed_plan",
            return_value=True,
        ),
        patch(
            "evoflow.collab.supervisor_plan_gate.collaboration_has_execution_authorization",
            return_value=False,
        ),
    ):
        out = check_supervisor_collab_gate("complete_subtask", "thread-1")
    assert out is not None
    assert out["error_code"] == "need_execution_authorization"


def test_create_task_with_subtasks_after_plan_returns_already_synced() -> None:
    with patch(
        "evoflow.collab.supervisor_plan_gate.collaboration_has_committed_plan",
        return_value=True,
    ):
        out = check_supervisor_collab_gate("create_task_with_subtasks", "thread-1")
    assert out is not None
    assert out["error_code"] == "plan_subtasks_already_synced"
    assert out["action"] == "create_task_with_subtasks"
    assert "create_task_with_subtasks" in out["message"]


def test_create_subtasks_after_plan_returns_already_synced() -> None:
    with patch(
        "evoflow.collab.supervisor_plan_gate.collaboration_has_committed_plan",
        return_value=True,
    ):
        out = check_supervisor_collab_gate("create_subtasks", "thread-1")
    assert out is not None
    assert out["error_code"] == "plan_subtasks_already_synced"


def test_get_status_not_gated() -> None:
    with patch(
        "evoflow.collab.supervisor_plan_gate.collaboration_has_committed_plan",
        return_value=False,
    ):
        assert check_supervisor_collab_gate("get_status", "thread-1") is None


def test_skipped_when_not_strict_plan_collab() -> None:
    with (
        patch(
            "evoflow.collab.supervisor_plan_gate.is_strict_plan_collaboration_for_thread",
            return_value=False,
        ),
        patch(
            "evoflow.collab.supervisor_plan_gate.collaboration_has_committed_plan",
            return_value=False,
        ),
    ):
        assert check_supervisor_collab_gate("create_task", "thread-1") is None
