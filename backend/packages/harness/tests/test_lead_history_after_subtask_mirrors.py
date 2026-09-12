"""Lead chat history must survive subtask mirror rows in the same session."""

from __future__ import annotations

from evoflow.persistence import chat_message_repositories as msg_repo
from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import reset_db_for_tests


def _mirror_row(sk: str, *, mid: str, sid: str, text: str) -> None:
    from evoflow.collab.thread_ids import collab_subtask_executor_thread_id

    lead = "thread-lead"
    executor = collab_subtask_executor_thread_id(lead, sid)
    msg_repo.append_message(
        sk,
        role="assistant",
        content_json={"content": text},
        thread_id=executor,
        parent_thread_id=lead,
        message_id=mid,
    )


def test_list_messages_for_display_skips_mirrors_but_keeps_lead(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "lead_hist.db"))
    reset_db_for_tests()
    sk = "agent:main:collab-lead"
    sess_repo.upsert_session_row(
        sk,
        thread_id="thread-lead",
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={},
        title="collab",
    )

    msg_repo.append_message(
        sk,
        role="user",
        content="plan this task",
        thread_id="thread-lead",
        message_id="user-1",
    )
    msg_repo.append_message(
        sk,
        role="assistant",
        content="here is the plan",
        thread_id="thread-lead",
        message_id="lead-1",
    )

    for i in range(250):
        _mirror_row(sk, mid=f"Subtask_x:src:{i}", sid="Subtask_x", text=f"worker chunk {i}")

    msg_repo.append_message(
        sk,
        role="user",
        content="continue",
        thread_id="thread-lead",
        message_id="user-2",
    )
    msg_repo.append_message(
        sk,
        role="assistant",
        content="monitoring subtasks",
        thread_id="thread-lead",
        message_id="lead-2",
    )

    for i in range(250, 400):
        _mirror_row(sk, mid=f"Subtask_y:src:{i}", sid="Subtask_y", text=f"worker chunk {i}")

    display = msg_repo.list_messages_for_display(sk, limit=200)
    texts = [
        str((m.get("content_json") or {}).get("content") or "")
        for m in display
        if m.get("role") in ("user", "assistant")
    ]
    assert all("content" not in m for m in display)
    assert "plan this task" in texts
    assert "here is the plan" in texts
    assert "continue" in texts
    assert "monitoring subtasks" in texts
    assert not any("worker chunk" in t for t in texts)
    assert len(display) == 4
