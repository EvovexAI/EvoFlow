"""Chat transcript thread lineage: parent_thread_id + executor thread scope."""

from __future__ import annotations

from evoflow.collab.thread_ids import collab_subtask_executor_thread_id
from evoflow.persistence import chat_message_repositories as msg_repo
from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import get_db, reset_db_for_tests


def test_subtask_rows_use_executor_thread_and_parent(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "parent_thread.db"))
    reset_db_for_tests()
    sk = "agent:main:subtask-scope"
    lead = "50907089-bb6b-48c2-a0d0-971f99a42e89"
    sid = "Subtask_alpha"
    executor = collab_subtask_executor_thread_id(lead, sid)
    sess_repo.upsert_session_row(
        sk,
        thread_id=lead,
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={},
        title="collab",
    )

    msg_repo.append_message(
        sk,
        role="user",
        content="lead user",
        thread_id=lead,
        message_id="lead-u1",
        run_id="run-lead-1",
    )
    msg_repo.append_message(
        sk,
        role="assistant",
        content="worker chunk",
        thread_id=executor,
        parent_thread_id=lead,
        message_id=f"{sid}:src:1",
        run_id="run-sub-1",
        model_name="worker-model-x",
        input_tokens=10,
        output_tokens=20,
        total_tokens=30,
    )

    lead_display = msg_repo.list_messages_for_display(sk, limit=50)
    assert len(lead_display) == 1
    assert "content" not in lead_display[0]
    assert lead_display[0]["content_json"]["content"] == "lead user"
    assert lead_display[0].get("run_id") == "run-lead-1"

    sub_display = msg_repo.list_messages_for_thread_id(executor, limit=50)
    assert len(sub_display) == 1
    assert "content" not in sub_display[0]
    assert sub_display[0]["content_json"]["content"] == "worker chunk"
    assert sub_display[0].get("parent_thread_id") == lead
    assert sub_display[0].get("thread_id") == executor
    assert sub_display[0].get("run_id") == "run-sub-1"
    assert sub_display[0].get("model_name") == "worker-model-x"
    assert sub_display[0].get("input_tokens") == 10


def test_resolve_parent_thread_id_from_executor_pattern() -> None:
    lead = "abc-123"
    executor = collab_subtask_executor_thread_id(lead, "Subtask_x")
    assert msg_repo.resolve_parent_thread_id(executor) == lead
    assert msg_repo.resolve_parent_thread_id(lead) is None


def test_session_binding_thread_id_keeps_lead_on_executor_writes() -> None:
    lead = "50907089-bb6b-48c2-a0d0-971f99a42e89"
    tool_call = "call_subagent_abc"
    executor = collab_subtask_executor_thread_id(lead, tool_call)
    assert msg_repo.session_binding_thread_id(executor, lead) == lead
    assert msg_repo.session_binding_thread_id(lead, lead) == lead


def test_delegate_subagent_executor_thread_uses_tool_call_id() -> None:
    lead = "98408fb8-87a7-40a3-a60c-1b789cc64059"
    tc = "call_delegate_01"
    executor = collab_subtask_executor_thread_id(lead, tc)
    assert executor.endswith(f"__sub__{tc}")
    assert msg_repo.resolve_parent_thread_id(executor) == lead


def test_subagent_transcript_excluded_from_lead_display(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "delegate_subagent.db"))
    reset_db_for_tests()
    sk = "agent:main:delegate"
    lead = "98408fb8-87a7-40a3-a60c-1b789cc64059"
    tc = "call_delegate_99"
    executor = collab_subtask_executor_thread_id(lead, tc)
    sess_repo.upsert_session_row(
        sk,
        thread_id=lead,
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={},
        title="chat",
    )
    msg_repo.append_message(sk, role="user", content="main ask", thread_id=lead, message_id="u1")
    msg_repo.append_message(
        sk,
        role="assistant",
        content="subagent work",
        thread_id=executor,
        parent_thread_id=lead,
        message_id="sub-a1",
    )
    lead_rows = msg_repo.list_messages_for_display(sk, limit=20)
    assert len(lead_rows) == 1
    assert lead_rows[0]["content_json"]["content"] == "main ask"
    sub_rows = msg_repo.list_messages_for_thread_id(executor, limit=20)
    assert len(sub_rows) == 1
    assert sub_rows[0]["content_json"]["content"] == "subagent work"


def test_lead_message_does_not_self_parent(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "lead_parent.db"))
    reset_db_for_tests()
    sk = "agent:main:lead-parent"
    lead = "98408fb8-87a7-40a3-a60c-1b789cc64059"
    sess_repo.upsert_session_row(
        sk,
        thread_id=lead,
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={},
        title="lead",
    )
    msg_repo.append_message(
        sk,
        role="user",
        content="hello",
        thread_id=lead,
        message_id="u1",
        run_id="run-1",
    )
    row = get_db().execute(
        "SELECT parent_thread_id FROM evoflow_chat_messages WHERE session_key = ? AND message_id = ?",
        (sk, "u1"),
    ).fetchone()
    assert row is not None
    assert row[0] is None
    assert len(msg_repo.list_messages_for_display(sk, limit=10)) == 1
