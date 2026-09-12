"""Supervisor get_subtask_conversation reads evoflow_chat_messages."""

from __future__ import annotations

import asyncio
import importlib
import json
from types import SimpleNamespace

import pytest

from evoflow.collab.conversation_persist import list_subtask_conversation_ui_messages
from evoflow.collab.storage import get_project_storage, new_project_bundle_root_task
from evoflow.collab.subtask_conversation import append_subtask_conversation_turn
from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import reset_db_for_tests
from evoflow.tools.builtins.supervisor.conversation import build_subtask_conversation_payload

supervisor_mod = importlib.import_module("evoflow.tools.builtins.supervisor_tool")


@pytest.fixture
def storage_with_subtask(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    reset_db_for_tests()
    storage = get_project_storage()
    project, task = new_project_bundle_root_task(
        "main",
        "test task for supervisor subtask conversation" + "x" * 10,
        thread_id="thread_supervisor_conv_test",
    )
    task_id = str(task["id"])
    subtask_id = "Subtask_test_conv_001"
    task["subtasks"] = [
        {
            "id": subtask_id,
            "name": "dev step",
            "status": "in_progress",
            "assigned_to": "claude-code",
            "claude_session_id": "sess_test_1",
        }
    ]
    storage.save_project(project)
    lead_thread = str(task.get("thread_id") or "").strip()
    sk = "agent:main:supervisor-conv-test"
    sess_repo.upsert_session_row(
        sk,
        thread_id=lead_thread,
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={},
        title="collab",
    )
    append_subtask_conversation_turn(
        storage,
        task_id,
        subtask_id,
        user_text="请实现 API",
        assistant_text="已实现 GET /todos。",
    )
    return storage, task_id, subtask_id


def _run_supervisor(storage, **kwargs) -> dict:
    supervisor_mod.get_project_storage = lambda: storage
    runtime = SimpleNamespace(
        context={"thread_id": "thread_supervisor_conv_test"},
        config={"configurable": {"thread_id": "thread_supervisor_conv_test"}},
    )

    async def _go():
        return await supervisor_mod.supervisor_tool.coroutine(
            tool_call_id="tc-conv",
            runtime=runtime,
            **kwargs,
        )

    raw = asyncio.run(_go())
    return json.loads(raw)


def test_build_subtask_conversation_payload(storage_with_subtask):
    storage, task_id, subtask_id = storage_with_subtask
    out = build_subtask_conversation_payload(
        storage,
        task_id=task_id,
        subtask_id=subtask_id,
    )
    assert out["success"] is True
    assert out["messageCount"] >= 2
    assert "GET /todos" in out["transcript"]


def test_get_subtask_conversation_from_chat_messages(storage_with_subtask):
    storage, task_id, subtask_id = storage_with_subtask
    out = _run_supervisor(
        storage,
        action="get_subtask_conversation",
        task_id=task_id,
        subtask_id=subtask_id,
    )
    assert out["success"] is True
    assert out["action"] == "get_subtask_conversation"
    assert out["taskId"] == task_id
    assert out["subtaskId"] == subtask_id
    assert out["messageCount"] >= 2
    assert "assistant" in out["transcript"]
    assert "GET /todos" in out["transcript"]

    row = storage.load_project(storage.list_projects()[0]["id"])
    task = next(t for t in row["tasks"] if t["id"] == task_id)
    expected = list_subtask_conversation_ui_messages(task, subtask_id)
    assert out["messageCount"] == len(expected)


def test_get_task_memory_alias_still_works(storage_with_subtask):
    storage, task_id, subtask_id = storage_with_subtask
    out = _run_supervisor(
        storage,
        action="get_task_memory",
        task_id=task_id,
        subtask_id=subtask_id,
    )
    assert out["success"] is True
    assert out["action"] == "get_subtask_conversation"
    assert out.get("deprecatedAction") == "get_task_memory"


def test_get_subtask_conversation_requires_subtask(storage_with_subtask):
    storage, task_id, _subtask_id = storage_with_subtask
    out = _run_supervisor(
        storage,
        action="get_subtask_conversation",
        task_id=task_id,
    )
    assert out["success"] is False
