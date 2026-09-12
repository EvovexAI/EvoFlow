"""Tests for IM channel user transcript persistence."""

from __future__ import annotations

import tempfile

import pytest

from app.channels.manager import _persist_channel_user_transcript_turn
from evoflow.persistence import chat_message_repositories as msg_repo
from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.session_run_state import RUN_STATUS_DONE, peek_current_run_id


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        get_db()
        yield
        reset_db_for_tests()


def test_persist_channel_user_transcript_turn(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:feishu:oc_test"
    tid = "thread-feishu-1"
    sess_repo.upsert_session_row(sk, thread_id=tid, title="feishu", created_at_ms=1, updated_at_ms=1)

    run_id = _persist_channel_user_transcript_turn(sk, tid, "你好，第二条")

    assert run_id
    assert peek_current_run_id(session_key=sk) == run_id
    rows = msg_repo.list_messages_for_display(sk)
    user_rows = [r for r in rows if str(r.get("role") or "").lower() == "user"]
    assert len(user_rows) == 1
    payload = user_rows[0].get("content_json") or {}
    assert "第二条" in str(payload.get("content") or "")

    from evoflow.persistence.session_run_state import mark_session_run_ended

    mark_session_run_ended(session_key=sk)
    row = get_db().execute(
        "SELECT run_status, current_run_id FROM evoflow_chat_sessions WHERE session_key = ?",
        (sk,),
    ).fetchone()
    assert row[0] == RUN_STATUS_DONE
    assert row[1] is None or str(row[1]).strip() == ""
