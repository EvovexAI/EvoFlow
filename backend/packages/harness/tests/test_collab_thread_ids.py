"""Collab executor thread id format must satisfy Paths thread_dir validation."""

import re

from evoflow.collab.thread_ids import (
    SUBTASK_THREAD_SEP,
    collab_subtask_executor_thread_id,
    is_collab_executor_thread,
    is_langgraph_lead_thread_id,
    lead_thread_from_executor_thread,
    normalize_collab_executor_thread_id,
    resolve_langgraph_lead_thread_id,
)

_SAFE_THREAD_ID_RE = re.compile(r"^[A-Za-z0-9_\-]+$")


def test_collab_subtask_executor_thread_id_is_path_safe():
    lead = "d964e42a-3950-4563-b273-ccd057d98eca"
    sub = "Subtask_20260529155400_874490"
    tid = collab_subtask_executor_thread_id(lead, sub)
    assert SUBTASK_THREAD_SEP in tid
    assert "::" not in tid
    assert _SAFE_THREAD_ID_RE.match(tid)
    assert is_collab_executor_thread(tid)
    assert lead_thread_from_executor_thread(tid) == lead


def test_normalize_legacy_colon_separator():
    legacy = "d964e42a-3950-4563-b273-ccd057d98eca::sub::Subtask_20260529155400_874490"
    normalized = normalize_collab_executor_thread_id(legacy)
    assert _SAFE_THREAD_ID_RE.match(normalized)
    assert lead_thread_from_executor_thread(normalized) == "d964e42a-3950-4563-b273-ccd057d98eca"
    assert normalized.endswith("Subtask_20260529155400_874490")


def test_collab_executor_thread_id_normalizes_nested_lead():
    from evoflow.collab.thread_ids import normalize_lead_thread_id

    lead = "1.1db6cc9c-8924-4ab3-88cf-590a2b727a53"
    parent_sub = "Subtask_20260530123033_667763"
    child_sub = "Subtask_20260530123033_001799"
    nested_lead = collab_subtask_executor_thread_id(lead, parent_sub)
    good = collab_subtask_executor_thread_id(lead, child_sub)
    doubled = f"{nested_lead}{SUBTASK_THREAD_SEP}{child_sub}"
    assert collab_subtask_executor_thread_id(nested_lead, child_sub) == good
    assert collab_subtask_executor_thread_id(nested_lead, child_sub) != doubled
    assert normalize_lead_thread_id(nested_lead) == lead


def test_lead_thread_from_executor_thread_unwraps_nested_lead_segment():
    lead = "50907089-bb6b-48c2-a0d0-971f99a42e89"
    parent_sub = "Subtask_parent"
    child_sub = "Subtask_child"
    nested_lead = collab_subtask_executor_thread_id(lead, parent_sub)
    intermediate_tid = f"{nested_lead}{SUBTASK_THREAD_SEP}{child_sub}"
    assert lead_thread_from_executor_thread(nested_lead) == lead
    assert lead_thread_from_executor_thread(intermediate_tid) == lead


def test_resolve_subtask_executor_thread_id_prefers_canonical():
    from evoflow.collab.thread_ids import resolve_subtask_executor_thread_id

    lead = "50907089-bb6b-48c2-a0d0-971f99a42e89"
    parent_sub = "Subtask_parent"
    child_sub = "Subtask_child"
    nested = collab_subtask_executor_thread_id(
        collab_subtask_executor_thread_id(lead, parent_sub),
        child_sub,
    )
    canonical = collab_subtask_executor_thread_id(lead, child_sub)
    assert resolve_subtask_executor_thread_id(lead, child_sub, stored_subtask_thread_id=nested) == canonical


def test_resolve_keeps_stored_when_lead_uuid_recreated():
    """LangGraph restart replaces lead UUID; chat rows stay under old executor thread."""
    from evoflow.collab.thread_ids import resolve_subtask_executor_thread_id

    old_lead = "50907089-bb6b-48c2-a0d0-971f99a42e89"
    new_lead = "c5525aa9-d737-46f8-973c-fa82d8a9641d"
    sid = "Subtask_20260531080703_623573"
    stored = collab_subtask_executor_thread_id(old_lead, sid)
    assert (
        resolve_subtask_executor_thread_id(new_lead, sid, stored_subtask_thread_id=stored) == stored
    )
    assert resolve_subtask_executor_thread_id(None, sid, stored_subtask_thread_id=f"SubThread_{sid}") == (
        f"SubThread_{sid}"
    )


def test_persist_subtask_stream_without_lead_writes_chat_rows(tmp_path, monkeypatch):
    """Workflow app runs have no lead session — must still write evoflow_chat_messages."""
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    from evoflow.collab.conversation_persist import (
        append_collab_subtask_stream_message,
        list_subtask_conversation_ui_messages,
    )
    from evoflow.collab.storage import get_project_storage, new_project_bundle_root_task
    from evoflow.persistence.db import reset_db_for_tests

    reset_db_for_tests()
    storage = get_project_storage()
    project, task = new_project_bundle_root_task(
        "wf",
        "workflow run without lead thread" + "x" * 10,
        thread_id=None,
    )
    task_id = str(task["id"])
    subtask_id = "Subtask_wf_001"
    task["subtasks"] = [
        {
            "id": subtask_id,
            "name": "step",
            "status": "in_progress",
            "subtask_thread_id": f"SubThread_{subtask_id}",
        }
    ]
    storage.save_project(project)
    ok = append_collab_subtask_stream_message(
        task_id,
        subtask_id,
        {"role": "assistant", "type": "ai", "content": "workflow hello", "id": "ai-wf-1"},
        1,
        parent_thread_id=None,
    )
    assert ok is True
    row = storage.load_project(project["id"])
    main = next(t for t in row["tasks"] if t["id"] == task_id)
    conv = list_subtask_conversation_ui_messages(main, subtask_id)
    assert any("workflow hello" in str(m.get("content") or "") for m in conv)


def test_executor_thread_is_not_langgraph_lead_thread_id():
    lead = "c5525aa9-d737-46f8-973c-fa82d8a9641d"
    sub = "Subtask_20260531080703_623573"
    executor = collab_subtask_executor_thread_id(lead, sub)
    assert is_langgraph_lead_thread_id(lead) is True
    assert is_langgraph_lead_thread_id(executor) is False
    assert resolve_langgraph_lead_thread_id(executor) == lead
    assert resolve_langgraph_lead_thread_id(lead) == lead
    assert resolve_langgraph_lead_thread_id("SubThread_orphan") is None


def test_goal_checkpoint_thread_id_is_valid_uuid():
    from evoflow.collab.thread_ids import (
        goal_checkpoint_thread_id,
        is_goal_checkpoint_thread_id,
        is_langgraph_lead_thread_id,
    )

    lead = "c5525aa9-d737-46f8-973c-fa82d8a9641d"
    hosted_id = "hosted-eab55fe726734377"
    tid = goal_checkpoint_thread_id(lead, hosted_id)
    assert is_langgraph_lead_thread_id(tid) is True
    assert is_goal_checkpoint_thread_id(tid) is True
    assert goal_checkpoint_thread_id(lead, hosted_id) == tid
    assert goal_checkpoint_thread_id(lead, "other") != tid
