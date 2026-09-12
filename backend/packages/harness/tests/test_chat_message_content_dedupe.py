"""Transcript append dedupe by content / tool_call_id (dual-write guard)."""

from __future__ import annotations

from evoflow.persistence import chat_message_repositories as msg_repo
from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import reset_db_for_tests


def test_append_skips_duplicate_content_same_run(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "dedupe.db"))
    reset_db_for_tests()
    sk = "agent:main:dedupe-test"
    sess_repo.upsert_session_row(
        sk,
        thread_id="t-dedupe",
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={},
        title="t",
    )
    run_id = "run-1"
    first = msg_repo.append_message(
        sk,
        role="assistant",
        content="hello world",
        run_id=run_id,
        thread_id="t-dedupe",
    )
    assert first is not None
    second = msg_repo.append_message(
        sk,
        role="assistant",
        content="hello world",
        message_id="langgraph-a1",
        run_id=run_id,
        thread_id="t-dedupe",
    )
    assert second is None
    count = msg_repo.count_messages(sk)
    assert count == 1


def test_append_skips_duplicate_tool_call_id(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "tool.db"))
    reset_db_for_tests()
    sk = "agent:main:tool-dedupe"
    sess_repo.upsert_session_row(
        sk,
        thread_id="t-tool",
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={},
        title="t",
    )
    msg_repo.append_message(
        sk,
        role="tool",
        content='{"ok":true}',
        tool_call_id="tc-99",
        run_id="run-t",
        thread_id="t-tool",
    )
    dup = msg_repo.append_message(
        sk,
        role="tool",
        content='{"ok":true}',
        message_id="tool-msg-2",
        tool_call_id="tc-99",
        run_id="run-t",
        thread_id="t-tool",
    )
    assert dup is None
    assert msg_repo.count_messages(sk) == 1


def test_append_skips_duplicate_when_middleware_row_has_no_run_id(tmp_path, monkeypatch) -> None:
    """TranscriptMiddleware omits run_id; frontend batch / partial-abort must not duplicate."""
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "null-run.db"))
    reset_db_for_tests()
    sk = "agent:main:null-run-dedupe"
    sess_repo.upsert_session_row(
        sk,
        thread_id="t-null-run",
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={},
        title="t",
    )
    first = msg_repo.append_message(
        sk,
        role="assistant",
        content="same reply text",
        message_id="langgraph-uuid-1",
        thread_id="t-null-run",
    )
    assert first is not None
    second = msg_repo.append_message(
        sk,
        role="assistant",
        content="same reply text",
        message_id="partial-abort-run-1",
        run_id="run-1",
        thread_id="t-null-run",
    )
    assert second is None
    assert msg_repo.count_messages(sk) == 1


def test_user_message_id_dedupe(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "user.db"))
    reset_db_for_tests()
    sk = "agent:main:user-dedupe"
    sess_repo.upsert_session_row(
        sk,
        thread_id="t-user",
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={},
        title="t",
    )
    msg_repo.append_message(
        sk,
        role="user",
        content="ping",
        message_id="u-fixed",
        run_id="run-u",
        thread_id="t-user",
    )
    again = msg_repo.append_message(
        sk,
        role="user",
        content="ping",
        message_id="u-fixed",
        run_id="run-u",
        thread_id="t-user",
    )
    assert again is None
    assert msg_repo.count_messages(sk) == 1
