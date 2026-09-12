"""run_id resolution on append and display enrichment."""

from __future__ import annotations

from evoflow.persistence import chat_message_repositories as msg_repo
from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import reset_db_for_tests
from evoflow.persistence.session_run_state import mark_session_run_started


def test_append_tool_inherits_latest_user_run_id(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "tool-run.db"))
    reset_db_for_tests()
    sk = "agent:main:tool-run"
    tid = "thread-tool-run"
    sess_repo.upsert_session_row(
        sk,
        thread_id=tid,
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={},
        title="t",
    )
    msg_repo.append_message(
        sk,
        role="user",
        content="设计角色",
        run_id="run-abc",
        thread_id=tid,
        message_id="u-1",
    )
    tool = msg_repo.append_message(
        sk,
        role="tool",
        content='{"title": "调研"}',
        tool_name="ask_clarification",
        tool_call_id="tc-1",
        thread_id=tid,
        message_id="tool-1",
    )
    assert tool is not None
    rows = msg_repo.list_messages(sk, limit=10)
    tool_rows = [r for r in rows if r["role"] == "tool"]
    assert len(tool_rows) == 1
    assert tool_rows[0].get("run_id") == "run-abc"


def test_list_messages_for_display_forward_fills_run_id(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "display-run.db"))
    reset_db_for_tests()
    sk = "agent:main:display-run"
    tid = "thread-display-run"
    sess_repo.upsert_session_row(
        sk,
        thread_id=tid,
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={},
        title="t",
    )
    msg_repo.append_message(
        sk,
        role="user",
        content="hi",
        run_id="run-display",
        thread_id=tid,
        message_id="u-d",
    )
    msg_repo.append_message(
        sk,
        role="tool",
        content="ok",
        tool_name="ask_clarification",
        tool_call_id="tc-d",
        thread_id=tid,
        message_id="t-d",
        run_id=None,
    )
    display = msg_repo.list_messages_for_display(sk, limit=20)
    tool_disp = [m for m in display if m.get("type") == "tool"]
    assert tool_disp
    assert tool_disp[-1].get("run_id") == "run-display"


def test_backfill_turn_scoped_does_not_tag_next_user_turn(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "turn-scope.db"))
    reset_db_for_tests()
    sk = "agent:main:turn-scope"
    tid = "thread-turn-scope"
    sess_repo.upsert_session_row(
        sk,
        thread_id=tid,
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={},
        title="t",
    )
    msg_repo.append_message(sk, role="user", content="q1", run_id="run-a", thread_id=tid, message_id="u1")
    msg_repo.append_message(
        sk,
        role="tool",
        content="tool-a",
        tool_name="scenario",
        tool_call_id="tc-a",
        thread_id=tid,
        message_id="t-a",
    )
    msg_repo.append_message(sk, role="user", content="q2", run_id="run-b", thread_id=tid, message_id="u2")
    msg_repo.append_message(
        sk,
        role="tool",
        content="tool-b",
        tool_name="web_search",
        tool_call_id="tc-b",
        thread_id=tid,
        message_id="t-b",
    )
    msg_repo.backfill_missing_run_ids_in_session(sk, thread_id=tid)
    rows = msg_repo.list_messages(sk, limit=20)
    by_mid = {r.get("message_id"): r for r in rows}
    assert by_mid["t-a"].get("run_id") == "run-a"
    assert by_mid["t-b"].get("run_id") == "run-b"


def test_enrich_run_ids_all_roles(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "enrich.db"))
    reset_db_for_tests()
    from evoflow.persistence.transcript_run_id import enrich_run_ids_in_order

    enriched = enrich_run_ids_in_order(
        [
            {"role": "user", "run_id": "run-1"},
            {"role": "assistant"},
            {"role": "tool"},
            {"role": "user", "run_id": "run-2"},
            {"role": "tool", "tool_name": "grep"},
        ]
    )
    assert enriched[1]["run_id"] == "run-1"
    assert enriched[2]["run_id"] == "run-1"
    assert enriched[4]["run_id"] == "run-2"


def test_append_assistant_uses_peek_current_run_id(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "peek-run.db"))
    reset_db_for_tests()
    sk = "agent:main:peek-run"
    tid = "thread-peek"
    sess_repo.upsert_session_row(
        sk,
        thread_id=tid,
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={},
        title="t",
    )
    mark_session_run_started(session_key=sk, run_id="run-peeking", thread_id=tid)
    res = msg_repo.append_message(
        sk,
        role="assistant",
        content="partial",
        thread_id=tid,
        message_id="a-partial",
    )
    assert res is not None
    rows = msg_repo.list_messages(sk, limit=5)
    assert rows[-1].get("run_id") == "run-peeking"
