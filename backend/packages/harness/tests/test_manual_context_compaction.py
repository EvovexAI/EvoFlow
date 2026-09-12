"""Tests for manual context compaction API service."""

from __future__ import annotations

import pytest

from evoflow.agents.manual_context_compaction import ManualCompactionError, run_manual_context_compaction
from evoflow.persistence import session_repositories as sess_repo


@pytest.fixture
def session_db(tmp_path, monkeypatch):
    db_path = tmp_path / "manual_compact.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence.db import init_db

    init_db()
    return db_path


@pytest.mark.asyncio
async def test_manual_compaction_allows_running_session(session_db, monkeypatch):
    from langchain_core.messages import AIMessage, HumanMessage

    sk = "agent:test:manual-running"
    tid = "tid-run"
    sess_repo.upsert_session_row(sk, thread_id=tid, title="running", run_status="running")

    from evoflow.persistence import chat_message_repositories as msg_repo

    msg_repo.append_message(sk, role="user", content="hello", thread_id=tid)
    msg_repo.append_message(sk, role="assistant", content="hi", thread_id=tid)

    folded = [
        HumanMessage(content="[summary]\nfolded", name="conversation_summary"),
        HumanMessage(content="latest user"),
        AIMessage(content="latest ai"),
    ]

    async def _fake_build(messages, runtime, *, force=False):
        return folded

    monkeypatch.setattr(
        "evoflow.agents.manual_context_compaction.build_ephemeral_model_messages",
        _fake_build,
    )
    monkeypatch.setattr(
        "evoflow.agents.manual_context_compaction.get_context_compaction_engine",
        lambda: type("E", (), {"set_previous_summary": lambda *a, **k: "ok"})(),
    )

    row = sess_repo.get_session_row_for_ui(sk)
    result = await run_manual_context_compaction(sk, session_row=row)
    assert result.ok is True
    assert result.changed is True


@pytest.mark.asyncio
async def test_manual_compaction_rejects_too_few_messages(session_db):
    sk = "agent:test:manual-empty"
    sess_repo.upsert_session_row(sk, thread_id="tid-empty", title="empty")
    row = sess_repo.get_session_row_for_ui(sk)
    with pytest.raises(ManualCompactionError) as exc:
        await run_manual_context_compaction(sk, session_row=row)
    assert "not enough messages" in str(exc.value).lower()


@pytest.mark.asyncio
async def test_manual_compaction_force_path(session_db, monkeypatch):
    from langchain_core.messages import AIMessage, HumanMessage

    sk = "agent:test:manual-ok"
    tid = "tid-manual-ok"
    sess_repo.upsert_session_row(sk, thread_id=tid, title="manual", model_name="deepseek-v4-flash")

    from evoflow.persistence import chat_message_repositories as msg_repo

    msg_repo.append_message(sk, role="user", content="hello", thread_id=tid)
    msg_repo.append_message(sk, role="assistant", content="hi there", thread_id=tid)

    folded = [
        HumanMessage(content="[summary]\nfolded", name="conversation_summary"),
        HumanMessage(content="latest user"),
        AIMessage(content="latest ai"),
    ]

    async def _fake_build(messages, runtime, *, force=False):
        assert force is True
        assert len(messages) >= 2
        return folded

    persisted: list = []

    class _FakeEngine:
        def set_previous_summary(self, *_a, **kwargs):
            persisted.append(kwargs.get("session_key"))
            return "ok"

    monkeypatch.setattr(
        "evoflow.agents.manual_context_compaction.build_ephemeral_model_messages",
        _fake_build,
    )
    monkeypatch.setattr(
        "evoflow.agents.manual_context_compaction.get_context_compaction_engine",
        lambda: _FakeEngine(),
    )

    row = sess_repo.get_session_row_for_ui(sk)
    result = await run_manual_context_compaction(sk, session_row=row)
    assert result.ok is True
    assert result.changed is True
    assert result.persisted_summary is True
    assert persisted and persisted[0] == sk
    assert result.context_usage["used_tokens"] >= 0
