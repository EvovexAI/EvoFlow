"""Tests for ephemeral subtask interrupt / steer."""

from __future__ import annotations

import asyncio
import importlib
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from evoflow.collab.storage import get_project_storage, new_project_bundle_root_task
from evoflow.collab.subtask_steering import (
    interrupt_subtask_background_run,
    is_ephemeral_task_tool_subtask,
    steer_ephemeral_subtask,
)
from evoflow.persistence.db import reset_db_for_tests

supervisor_mod = importlib.import_module("evoflow.tools.builtins.supervisor_tool")


@pytest.fixture
def storage_with_ephemeral_subtask(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    reset_db_for_tests()
    storage = get_project_storage()
    project, task = new_project_bundle_root_task(
        "main",
        "test task for subtask steering" + "x" * 10,
        thread_id="thread_steer_test",
    )
    task_id = str(task["id"])
    subtask_id = "Subtask_steer_001"
    task["execution_authorized"] = True
    task["subtasks"] = [
        {
            "id": subtask_id,
            "name": "implement backend",
            "status": "in_progress",
            "assigned_to": "project-implementer",
            "worker_profile": {"base_subagent": "general-purpose", "tools": ["read_file"]},
            "background_task_id": "SupervisorExec_bg_test",
        }
    ]
    storage.save_project(project)
    return storage, task_id, subtask_id


def test_is_ephemeral_task_tool_subtask():
    assert is_ephemeral_task_tool_subtask({"assigned_to": "project-implementer", "worker_profile": {"base_subagent": "general-purpose"}})
    assert not is_ephemeral_task_tool_subtask({"assigned_to": "claude-code"})


def test_interrupt_cancels_background_task(storage_with_ephemeral_subtask):
    storage, task_id, subtask_id = storage_with_ephemeral_subtask
    bg_id = "SupervisorExec_bg_test"
    bg_result = MagicMock()
    bg_result.status = SimpleNamespace(name="RUNNING", value="running")
    store: dict[str, MagicMock] = {bg_id: bg_result}

    with patch("evoflow.subagents.executor.get_background_task_result", return_value=bg_result), patch(
        "evoflow.subagents.executor._background_tasks",
        store,
    ), patch("evoflow.subagents.executor._background_tasks_lock", MagicMock()), patch(
        "evoflow.subagents.executor.SubagentStatus",
        SimpleNamespace(CANCELLED=SimpleNamespace(name="CANCELLED", value="cancelled")),
    ):
        out = interrupt_subtask_background_run(storage, task_id, subtask_id, reason="stop for steer")
    assert out["ok"] is True
    assert out["interrupted"] is True
    from evoflow.cancellation import is_task_cancelled

    assert is_task_cancelled(bg_id)
    row = storage.load_project(storage.list_projects()[0]["id"])
    st = next(s for s in row["tasks"][0]["subtasks"] if s["id"] == subtask_id)
    assert st.get("background_task_id") in {"", None}
    assert st.get("status") == "in_progress"


def test_steer_ephemeral_subtask_detached(storage_with_ephemeral_subtask):
    storage, task_id, subtask_id = storage_with_ephemeral_subtask
    runtime = SimpleNamespace(
        context={"thread_id": "thread_steer_test"},
        config={"configurable": {"thread_id": "thread_steer_test"}},
    )

    async def _run():
        with patch(
            "evoflow.collab.subtask_steering.interrupt_subtask_background_run",
            return_value={"ok": True, "interrupted": True},
        ), patch(
            "evoflow.tools.builtins.collab_bridge.delegate_via_task_tool",
            new=AsyncMock(return_value="Task Detached. Background execution started for collab subtask."),
        ) as mock_delegate, patch(
            "evoflow.tools.builtins.collab_bridge.is_bridge_ready",
            return_value=(True, True),
        ):
            return await steer_ephemeral_subtask(
                runtime,
                storage,
                main_task_id=task_id,
                subtask_id=subtask_id,
                steer_message="implement GET /todos only",
                interrupt_first=True,
                wait_for_completion=False,
            ), mock_delegate

    out, mock_delegate = asyncio.run(_run())
    assert out["ok"] is True
    assert out["detached"] is True
    assert out["steerCount"] == 1
    mock_delegate.assert_awaited_once()
    assert "GET /todos" in mock_delegate.await_args.kwargs["prompt"]


def test_supervisor_steer_subtask_action(storage_with_ephemeral_subtask):
    storage, task_id, subtask_id = storage_with_ephemeral_subtask
    supervisor_mod.get_project_storage = lambda: storage
    runtime = SimpleNamespace(
        context={"thread_id": "thread_steer_test"},
        config={"configurable": {"thread_id": "thread_steer_test"}},
    )

    async def _go():
        with patch(
            "evoflow.collab.subtask_steering.steer_ephemeral_subtask",
            new=AsyncMock(return_value={"ok": True, "detached": True, "steerCount": 1}),
        ):
            return await supervisor_mod.supervisor_tool.coroutine(
                tool_call_id="tc-steer",
                runtime=runtime,
                action="steer_subtask",
                task_id=task_id,
                subtask_id=subtask_id,
                agent_message="focus on tests first",
            )

    raw = asyncio.run(_go())
    import json

    out = json.loads(raw)
    assert out["success"] is True
    assert out["action"] == "steer_subtask"


def test_supervisor_steer_subtask_resolves_task_id_from_runtime(storage_with_ephemeral_subtask):
    storage, task_id, subtask_id = storage_with_ephemeral_subtask
    supervisor_mod.get_project_storage = lambda: storage
    runtime = SimpleNamespace(
        context={"thread_id": "thread_steer_test", "collab_task_id": task_id},
        config={"configurable": {"thread_id": "thread_steer_test", "collab_task_id": task_id}},
    )

    async def _go():
        with patch(
            "evoflow.collab.subtask_steering.steer_ephemeral_subtask",
            new=AsyncMock(return_value={"ok": True, "detached": True, "steerCount": 1}),
        ) as mock_steer:
            raw = await supervisor_mod.supervisor_tool.coroutine(
                tool_call_id="tc-steer-2",
                runtime=runtime,
                action="steer_subtask",
                subtask_id=subtask_id,
                agent_message="finish verification",
            )
            return raw, mock_steer

    raw, mock_steer = asyncio.run(_go())
    import json

    out = json.loads(raw)
    assert out["success"] is True
    mock_steer.assert_awaited_once()
    assert mock_steer.await_args.kwargs["main_task_id"] == task_id
    assert mock_steer.await_args.kwargs["subtask_id"] == subtask_id


def test_continue_subtask_session_redirects_ephemeral_to_steer(storage_with_ephemeral_subtask):
    storage, task_id, subtask_id = storage_with_ephemeral_subtask
    supervisor_mod.get_project_storage = lambda: storage
    runtime = SimpleNamespace(
        context={"thread_id": "thread_steer_test", "collab_task_id": task_id},
        config={"configurable": {"thread_id": "thread_steer_test"}},
    )

    async def _go():
        with patch(
            "evoflow.collab.subtask_steering.steer_ephemeral_subtask",
            new=AsyncMock(return_value={"ok": True, "detached": True, "steerCount": 2}),
        ) as mock_steer:
            raw = await supervisor_mod.supervisor_tool.coroutine(
                tool_call_id="tc-continue",
                runtime=runtime,
                action="continue_subtask_session",
                subtask_id=subtask_id,
                agent_message="please finish E2E test",
                keep_session_open=True,
            )
            return raw, mock_steer

    raw, mock_steer = asyncio.run(_go())
    import json

    out = json.loads(raw)
    assert out["success"] is True
    assert out["action"] == "steer_subtask"
    assert out["redirectedFrom"] == "continue_subtask_session"
    mock_steer.assert_awaited_once()
