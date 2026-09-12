"""Tests for subtask multi-turn conversation persistence."""

from __future__ import annotations

import pytest

from evoflow.collab.conversation_persist import (
    append_collab_subtask_stream_message,
    flush_collab_subtask_stream_messages,
    list_subtask_conversation_ui_messages,
)
from evoflow.collab.storage import get_project_storage, new_project_bundle_root_task
from evoflow.collab.subtask_conversation import append_subtask_conversation_turn
from evoflow.collab.thread_ids import collab_subtask_executor_thread_id
from evoflow.persistence import chat_message_repositories as msg_repo
from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import reset_db_for_tests


@pytest.fixture
def storage_with_subtask(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    reset_db_for_tests()
    storage = get_project_storage()
    project, task = new_project_bundle_root_task(
        "main",
        "test task for subtask conversation" + "x" * 10,
        thread_id="thread_subtask_conv_test",
    )
    task_id = str(task["id"])
    subtask_id = "Subtask_test_001"
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
    sk = "agent:main:subtask-conv-test"
    sess_repo.upsert_session_row(
        sk,
        thread_id=lead_thread,
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={},
        title="collab",
    )
    return storage, task_id, subtask_id, lead_thread


def _subtask_chat_messages(task: dict, subtask_id: str) -> list[dict]:
    lead_thread = str(task.get("thread_id") or "").strip()
    executor = collab_subtask_executor_thread_id(lead_thread, subtask_id)
    return msg_repo.list_messages_for_thread_id(executor, limit=50)


def _display_content(row: dict) -> str:
    cj = row.get("content_json")
    if isinstance(cj, dict):
        return str(cj.get("content") or "")
    return str(row.get("content") or row.get("text") or "")


def test_append_subtask_conversation_turn_dedupes(storage_with_subtask):
    storage, task_id, subtask_id, _lead_thread = storage_with_subtask
    append_subtask_conversation_turn(
        storage,
        task_id,
        subtask_id,
        user_text="请修复测试失败",
        assistant_text="已修复 pytest。",
    )
    append_subtask_conversation_turn(
        storage,
        task_id,
        subtask_id,
        user_text="请修复测试失败",
        assistant_text="已修复 pytest。",
    )
    row = storage.load_project(storage.list_projects()[0]["id"])
    task = next(t for t in row["tasks"] if t["id"] == task_id)
    conv = list_subtask_conversation_ui_messages(task, subtask_id)
    roles = [m.get("role") for m in conv]
    assert roles.count("user") == 1
    assert roles.count("assistant") == 1


def test_append_subtask_conversation_multi_round(storage_with_subtask):
    storage, task_id, subtask_id, _lead_thread = storage_with_subtask
    append_subtask_conversation_turn(storage, task_id, subtask_id, user_text="round 1", assistant_text="reply 1")
    append_subtask_conversation_turn(storage, task_id, subtask_id, user_text="round 2", assistant_text="reply 2")
    row = storage.load_project(storage.list_projects()[0]["id"])
    task = next(t for t in row["tasks"] if t["id"] == task_id)
    conv = list_subtask_conversation_ui_messages(task, subtask_id)
    assert len(conv) == 4
    assert conv[0]["role"] == "user"
    assert conv[1]["role"] == "assistant"
    assert "round 2" in str(conv[2].get("content") or "")


def test_append_collab_subtask_stream_message_persists_chat_only(storage_with_subtask):

    storage, task_id, subtask_id, lead_thread = storage_with_subtask

    ok = append_collab_subtask_stream_message(
        task_id,
        subtask_id,
        {"role": "assistant", "content": "streaming chunk one", "id": "ai-1"},
        1,
        parent_thread_id=lead_thread,
        run_id="run-sub-1",
    )
    assert ok is True

    row2 = storage.load_project(storage.list_projects()[0]["id"])
    task2 = next(t for t in row2["tasks"] if t["id"] == task_id)
    assert not task2.get("execution_conversation")

    conv = list_subtask_conversation_ui_messages(task2, subtask_id)
    assert len(conv) == 1
    assert "streaming chunk one" in str(conv[0].get("content") or "")

    collab_subtask_executor_thread_id(lead_thread, subtask_id)
    chat_rows = _subtask_chat_messages(task2, subtask_id)
    assert len(chat_rows) == 1
    assert chat_rows[0].get("role") == "assistant"
    assert "streaming chunk one" in _display_content(chat_rows[0])
    assert chat_rows[0].get("parent_thread_id") == lead_thread
    assert chat_rows[0].get("run_id") == "run-sub-1"


def test_append_collab_subtask_stream_message_normalizes_nested_lead(storage_with_subtask):
    from evoflow.collab.thread_ids import collab_subtask_executor_thread_id

    storage, task_id, subtask_id, lead_thread = storage_with_subtask
    parent_executor = collab_subtask_executor_thread_id(lead_thread, "Subtask_parent_fake")
    ok = append_collab_subtask_stream_message(
        task_id,
        subtask_id,
        {"role": "assistant", "content": "from nested lead fix", "id": "ai-nested"},
        1,
        parent_thread_id=parent_executor,
        run_id="run-nested-fix",
    )
    assert ok is True
    row = storage.load_project(storage.list_projects()[0]["id"])
    task = next(t for t in row["tasks"] if t["id"] == task_id)
    conv = list_subtask_conversation_ui_messages(task, subtask_id)
    assert any("from nested lead fix" in str(m.get("content") or "") for m in conv)
    executor = collab_subtask_executor_thread_id(lead_thread, subtask_id)
    chat_rows = msg_repo.list_messages_for_thread_id(executor, limit=50)
    assert any("from nested lead fix" in _display_content(r) for r in chat_rows)
    assert chat_rows[-1].get("run_id") == "run-nested-fix"


def test_append_collab_subtask_stream_message_persists_model_and_tokens(storage_with_subtask):
    from evoflow.collab.thread_ids import collab_subtask_executor_thread_id

    storage, task_id, subtask_id, lead_thread = storage_with_subtask
    ok = append_collab_subtask_stream_message(
        task_id,
        subtask_id,
        {
            "role": "assistant",
            "type": "ai",
            "content": "answer with usage",
            "id": "ai-usage-1",
            "response_metadata": {
                "model_name": "qwen-plus",
                "token_usage": {"prompt_tokens": 120, "completion_tokens": 45, "total_tokens": 165},
            },
        },
        1,
        parent_thread_id=lead_thread,
        run_id="run-usage-1",
        default_model_name="fallback-model",
    )
    assert ok is True
    executor = collab_subtask_executor_thread_id(lead_thread, subtask_id)
    chat_rows = msg_repo.list_messages_for_thread_id(executor, limit=50)
    row = next(r for r in chat_rows if "answer with usage" in _display_content(r))
    assert row.get("model_name") == "qwen-plus"
    assert row.get("input_tokens") == 120
    assert row.get("output_tokens") == 45
    assert row.get("total_tokens") == 165
    row2 = storage.load_project(storage.list_projects()[0]["id"])
    task = next(t for t in row2["tasks"] if t["id"] == task_id)
    conv = list_subtask_conversation_ui_messages(task, subtask_id)
    ui = next(m for m in conv if "answer with usage" in str(m.get("content") or ""))
    assert ui.get("model_name") == "qwen-plus"
    assert ui.get("input_tokens") == 120
    assert ui.get("output_tokens") == 45


def test_reconcile_lead_conversation_binds_thread_id(storage_with_subtask):
    from evoflow.collab.conversation_persist import reconcile_lead_conversation_from_chat

    storage, task_id, _subtask_id, lead_thread = storage_with_subtask
    row = storage.load_project(storage.list_projects()[0]["id"])
    task = next(t for t in row["tasks"] if t["id"] == task_id)
    task.pop("thread_id", None)
    storage.save_project(row)

    count = reconcile_lead_conversation_from_chat(storage, task_id, lead_thread)
    assert count >= 0

    row2 = storage.load_project(storage.list_projects()[0]["id"])
    task2 = next(t for t in row2["tasks"] if t["id"] == task_id)
    assert task2.get("thread_id") == lead_thread
    assert not task2.get("execution_conversation")


def test_flush_collab_subtask_stream_messages_skips_outcome_tool(storage_with_subtask):
    storage, task_id, subtask_id, lead_thread = storage_with_subtask
    executor = collab_subtask_executor_thread_id(lead_thread, subtask_id)

    outcome_id = "call-outcome-1"
    flushed = flush_collab_subtask_stream_messages(
        task_id,
        subtask_id,
        [
            {"id": "ai-1", "type": "ai", "content": "working on task1.txt"},
            {
                "id": "tool-write-1",
                "type": "tool",
                "name": "write",
                "tool_call_id": "call-write-1",
                "content": "wrote file",
            },
            {
                "id": "ai-2",
                "type": "ai",
                "content": "",
                "tool_calls": [{"id": outcome_id, "name": "subtask_outcome_report", "args": {}}],
            },
            {
                "id": "tool-outcome-1",
                "type": "tool",
                "name": "subtask_outcome_report",
                "tool_call_id": outcome_id,
                "content": "done",
            },
        ],
        parent_thread_id=lead_thread,
        run_id="run-flush-1",
    )
    assert flushed == 3

    rows = msg_repo.list_messages_for_thread_id(executor, limit=50)
    roles = [r.get("role") for r in rows]
    assert roles.count("assistant") == 2
    assert roles.count("tool") == 1
    assert all(str(r.get("tool_name") or "") != "subtask_outcome_report" for r in rows)
