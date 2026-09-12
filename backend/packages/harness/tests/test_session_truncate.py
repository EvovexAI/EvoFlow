"""In-place truncate for editing a sent user message (same session)."""

from __future__ import annotations

import tempfile
from unittest.mock import AsyncMock, patch

import pytest

from evoflow.persistence import chat_message_repositories as msg_repo
from evoflow.persistence import chat_session_service as chat_svc
from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        get_db()
        yield
        reset_db_for_tests()


def _seed(sk: str = "agent:main:new-truncsrc") -> str:
    sess_repo.upsert_session_row(
        sk,
        thread_id="t-parent",
        created_at_ms=1000,
        updated_at_ms=2000,
        message_count=0,
        context={"session_mode": "agent", "local_workspace_root": r"D:\dev\proj"},
        title="普通对话",
        agent_id="main",
        session_mode="agent",
    )
    msg_repo.append_message(sk, role="user", content="第一问", message_id="m1", thread_id="t-parent")
    msg_repo.append_message(sk, role="assistant", content="第一答", message_id="m2", thread_id="t-parent")
    msg_repo.append_message(sk, role="user", content="第二问", message_id="m3", thread_id="t-parent")
    msg_repo.append_message(sk, role="assistant", content="第二答", message_id="m4", thread_id="t-parent")
    return sk


def test_delete_messages_from_seq(sqlite_tmp: None) -> None:
    del sqlite_tmp
    src = _seed()
    assert msg_repo.delete_messages_from_seq(src, 3) == 2
    rows = msg_repo.list_messages(src, limit=50)
    assert [r["message_id"] for r in rows] == ["m1", "m2"]


@pytest.mark.asyncio
async def test_truncate_session_from_message_keeps_session(sqlite_tmp: None) -> None:
    del sqlite_tmp
    src = _seed()

    with patch.object(chat_svc, "delete_langgraph_thread", new=AsyncMock(return_value=True)):
        with patch.object(chat_svc, "create_langgraph_thread", new=AsyncMock(return_value="t-new")):
            result = await chat_svc.truncate_session_from_message(src, from_message_id="m3")

    assert result["sessionKey"] == src
    assert result["fromSeq"] == 3
    assert result["deletedCount"] == 2
    assert result["messageCount"] == 2
    assert result["threadId"] == "t-new"

    rows = msg_repo.list_messages(src, limit=50)
    assert [r["message_id"] for r in rows] == ["m1", "m2"]
    assert all(r.get("thread_id") == "t-new" for r in rows)

    ui = sess_repo.get_session_row_for_ui(src)
    assert ui is not None
    assert ui["title"] == "普通对话"
    assert str(ui.get("threadId") or "") == "t-new"


@pytest.mark.asyncio
async def test_truncate_first_user_message_empties(sqlite_tmp: None) -> None:
    del sqlite_tmp
    src = _seed()

    with patch.object(chat_svc, "delete_langgraph_thread", new=AsyncMock(return_value=True)):
        with patch.object(chat_svc, "create_langgraph_thread", new=AsyncMock(return_value="t-empty")):
            result = await chat_svc.truncate_session_from_message(src, from_message_id="m1")

    assert result["messageCount"] == 0
    assert msg_repo.count_messages(src) == 0
