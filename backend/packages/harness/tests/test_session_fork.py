"""Session fork: copy transcript into a new session (native-style)."""

from __future__ import annotations

import tempfile
from typing import Any
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


def _seed_parent(sk: str = "agent:main:new-forksrc") -> str:
    sess_repo.upsert_session_row(
        sk,
        thread_id="t-parent",
        created_at_ms=1000,
        updated_at_ms=2000,
        message_count=0,
        context={
            "session_mode": "agent",
            "local_workspace_root": r"D:\dev\proj",
            "model_name": "demo-model",
            "collab_task_id": "task-should-drop",
            "collab_phase": "running",
        },
        title="父会话标题",
        agent_id="main",
        session_mode="agent",
    )
    msg_repo.append_message(sk, role="user", content="第一问", message_id="m1", thread_id="t-parent")
    msg_repo.append_message(sk, role="assistant", content="第一答", message_id="m2", thread_id="t-parent")
    msg_repo.append_message(sk, role="user", content="第二问", message_id="m3", thread_id="t-parent")
    msg_repo.append_message(sk, role="assistant", content="第二答", message_id="m4", thread_id="t-parent")
    return sk


def test_copy_messages_for_fork_full_and_cut(sqlite_tmp: None) -> None:
    del sqlite_tmp
    src = _seed_parent()
    assert msg_repo.count_messages(src) == 4

    n = msg_repo.copy_messages_for_fork(src, "agent:main:new-forkdst", new_thread_id="t-child")
    assert n == 4
    rows = msg_repo.list_messages("agent:main:new-forkdst", limit=50)
    assert [r["seq"] for r in rows] == [1, 2, 3, 4]
    assert all(r.get("thread_id") == "t-child" for r in rows)
    assert rows[0]["message_id"] == "m1"
    assert "第一问" in str(rows[0].get("content") or rows[0].get("content_json") or "")

    n2 = msg_repo.copy_messages_for_fork(
        src, "agent:main:new-forkcut", through_seq=2, new_thread_id="t-cut"
    )
    assert n2 == 2
    cut_rows = msg_repo.list_messages("agent:main:new-forkcut", limit=50)
    assert [r["seq"] for r in cut_rows] == [1, 2]


@pytest.mark.asyncio
async def test_fork_session_full_copies_and_lineage(sqlite_tmp: None) -> None:
    del sqlite_tmp
    src = _seed_parent()

    async def _fake_ensure(session_key: str) -> str:
        return f"t-forked-{session_key[-8:]}"

    with patch.object(chat_svc, "ensure_session_thread", new=AsyncMock(side_effect=_fake_ensure)):
        result = await chat_svc.fork_session_full(src, title="我的分叉")

    dst = str(result["sessionKey"])
    assert dst != src
    assert result["forkedFromSessionKey"] == src
    assert result["messageCount"] == 4
    assert result["forkCutSeq"] is None

    child = sess_repo.get_session_row_for_ui(dst)
    assert child is not None
    assert child["title"] == "我的分叉"
    ctx = child.get("context") if isinstance(child.get("context"), dict) else {}
    assert ctx.get("forked_from_session_key") == src
    assert ctx.get("collab_phase") == "idle"
    assert "collab_task_id" not in ctx
    assert str(ctx.get("local_workspace_root") or "").replace("/", "\\").lower().endswith("proj")

    # Parent intact
    assert msg_repo.count_messages(src) == 4
    assert sess_repo.get_session_row_for_ui(src)["title"] == "父会话标题"


@pytest.mark.asyncio
async def test_fork_session_cut_by_message_id(sqlite_tmp: None) -> None:
    del sqlite_tmp
    src = _seed_parent()

    with patch.object(
        chat_svc,
        "ensure_session_thread",
        new=AsyncMock(return_value="t-cut-child"),
    ):
        result = await chat_svc.fork_session_full(src, through_message_id="m2")

    assert result["forkCutSeq"] == 2
    assert result["messageCount"] == 2
    rows = msg_repo.list_messages(result["sessionKey"], limit=50)
    assert len(rows) == 2
    assert rows[-1]["message_id"] == "m2"


@pytest.mark.asyncio
async def test_fork_session_before_message_id_exclusive(sqlite_tmp: None) -> None:
    del sqlite_tmp
    src = _seed_parent()

    with patch.object(
        chat_svc,
        "ensure_session_thread",
        new=AsyncMock(return_value="t-before-child"),
    ):
        # Edit/backtrack on second user turn (m3): keep only first Q/A
        result = await chat_svc.fork_session_full(src, before_message_id="m3")

    assert result["forkCutSeq"] == 2
    assert result["messageCount"] == 2
    rows = msg_repo.list_messages(result["sessionKey"], limit=50)
    assert [r["message_id"] for r in rows] == ["m1", "m2"]


@pytest.mark.asyncio
async def test_fork_session_before_first_message_empty(sqlite_tmp: None) -> None:
    del sqlite_tmp
    src = _seed_parent()

    with patch.object(
        chat_svc,
        "ensure_session_thread",
        new=AsyncMock(return_value="t-empty-child"),
    ):
        result = await chat_svc.fork_session_full(src, before_message_id="m1")

    assert result["forkCutSeq"] == 0
    assert result["messageCount"] == 0
    assert msg_repo.count_messages(result["sessionKey"]) == 0
    # Parent intact
    assert msg_repo.count_messages(src) == 4
