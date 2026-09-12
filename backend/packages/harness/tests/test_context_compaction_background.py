"""Background conversation compaction (fast path + message-table persistence)."""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, patch

from langchain_core.messages import AIMessage, HumanMessage, messages_to_dict

from evoflow.agents.compaction_trigger import get_compaction_trigger_cache, reset_compaction_trigger_cache_for_tests
from evoflow.agents.context_compaction_core import (
    ContextCompactionEngine,
    get_context_compaction_engine,
    plan_compaction,
)
from evoflow.context.context_compaction_queue import CompactionJob, get_context_compaction_queue


@pytest.fixture(autouse=True)
def _reset_trigger_cache():
    reset_compaction_trigger_cache_for_tests()
    yield


@pytest.fixture
def chat_db(tmp_path, monkeypatch):
    db_path = tmp_path / "compaction_bg.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence.db import init_db

    init_db()
    return db_path


def _big_messages(n: int = 40) -> list:
    text = "word " * 8000
    out = []
    for i in range(n):
        if i % 2 == 0:
            out.append(HumanMessage(content=f"u{i} {text}"))
        else:
            out.append(AIMessage(content=f"a{i} {text}"))
    return out


def test_compress_messages_fast_job_omits_stub_as_previous():
    """When there's no real prior summary, CompactionJob.previous_summary must be None.

    The stub placeholder is only for the current-turn fold; feeding it to the background
    LLM as ``previous_summary`` would cause the model to "update" placeholder text.
    """
    engine = ContextCompactionEngine()
    msgs = _big_messages()
    _, _, job = engine.compress_messages_fast(
        msgs,
        thread_id="bg-t1b",
        context_length=100_000,
        compaction_cooldown_seconds=0,
        compaction_hysteresis_enabled=False,
    )
    assert job is not None
    # 首次 fast 压缩时还没有真正的历史摘要，stub 不能被当成 previous 喂给后台 LLM
    assert job.previous_summary is None


def test_stub_summary_persists_to_message_table(chat_db):
    """Stub summaries are written to evoflow_chat_messages so hydration can anchor."""
    from evoflow.agents.context_compaction_core import _stub_summary
    from evoflow.persistence import session_repositories as sess_repo
    from evoflow.persistence.chat_message_repositories import load_conversation_summary_text

    sk = "agent:test:stub-persist"
    sess_repo.upsert_session_row(sk, thread_id="bg-stub-protect")
    engine = ContextCompactionEngine()
    stub = _stub_summary(middle_count=5, language="zh")
    engine.set_previous_summary("bg-stub-protect", stub, session_key=sk)
    loaded = load_conversation_summary_text(sk)
    assert loaded is not None
    assert "[占位摘要" in loaded or "[PLACEHOLDER SUMMARY" in loaded


def test_absorb_extracted_summaries_is_noop(chat_db):
    """Runtime-extracted summary bodies must not be merged back into chat_messages."""
    from evoflow.agents.context_compaction_core import ContextCompactionEngine, _stub_summary
    from evoflow.persistence.chat_message_repositories import load_conversation_summary_text

    sk = "agent:test:noop-absorb"
    sess_repo.upsert_session_row(sk, thread_id="bg-stub-absorb")
    engine = ContextCompactionEngine()
    stub = _stub_summary(middle_count=5, language="zh")
    engine.absorb_extracted_summaries("bg-stub-absorb", [stub], session_key=sk)
    assert load_conversation_summary_text(sk) is None


def test_compress_messages_fast_marks_cooldown():
    """compress_messages_fast must call mark_compress_completed so cooldown takes effect.

    Without this, the cooldown window stays open forever and every model call re-runs
    the full prune+fold flow (the bug fixed in NEW-1).
    """
    engine = ContextCompactionEngine()
    msgs = _big_messages()
    # 第一次 fast 压缩应该成功
    compressed1, changed1, job1 = engine.compress_messages_fast(
        msgs,
        thread_id="bg-cooldown",
        context_length=100_000,
        compaction_cooldown_seconds=60.0,
        compaction_hysteresis_enabled=True,
    )
    assert changed1 is True
    assert job1 is not None
    # 冷却窗口应已激活
    assert engine.compaction_cooldown_active("bg-cooldown", cooldown_seconds=60.0)
    # baseline 应记录压缩前的 gate tokens（非零）——这是 NEW-1 修复的核心
    snap = get_compaction_trigger_cache().snapshot(engine._tid("bg-cooldown"))
    assert snap is not None
    assert snap.before_gate_tokens > 0


def test_compress_messages_fast_returns_job_without_llm():
    engine = ContextCompactionEngine()
    msgs = _big_messages()
    with patch.object(engine, "_generate_summary", new_callable=AsyncMock) as mock_llm:
        compressed, changed, job = engine.compress_messages_fast(
            msgs,
            thread_id="bg-t1",
            context_length=100_000,
            compaction_cooldown_seconds=0,
            compaction_hysteresis_enabled=False,
        )
        mock_llm.assert_not_called()
    assert changed is True
    assert job is not None
    assert any(isinstance(m, HumanMessage) and getattr(m, "name", None) == "conversation_summary" for m in compressed)
    assert len(compressed) <= len(msgs)


def test_background_queue_persists_summary_to_message_table(chat_db, monkeypatch):
    from evoflow.persistence import session_repositories as sess_repo
    from evoflow.persistence.chat_message_repositories import load_conversation_summary_text

    sk = "agent:test:bg-queue"
    sess_repo.upsert_session_row(sk, thread_id="bg-t3")
    engine = get_context_compaction_engine()
    msgs = _big_messages()
    plan = plan_compaction(
        msgs,
        context_length=100_000,
        threshold_ratio=0.5,
        aggressive_ratio=0.85,
        protect_first_n=3,
        protect_tail_messages=20,
    )
    assert plan is not None
    job = CompactionJob(
        thread_id="bg-t3",
        middle_payload=messages_to_dict(plan.middle),
        context_length=100_000,
        previous_summary=None,
        aggressive=False,
        language="zh",
        session_key=sk,
    )

    async def _fake_summary(*_a, **_k):
        return "[CONTEXT COMPACTION — REFERENCE ONLY]\n## 目标\n队列测试\n"

    monkeypatch.setattr(engine, "generate_summary_for_turns", _fake_summary)
    q = get_context_compaction_queue()
    with patch.object(q, "_reset_timer"):
        import asyncio

        asyncio.run(q._process_batch_async({"bg-t3": job}))
    loaded = load_conversation_summary_text(sk)
    assert loaded is not None
    assert "队列测试" in loaded
