"""Hydrated transcript: DB SSOT for post-compaction tail (no refold reshaping)."""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from evoflow.agents.context_compaction_core import (
    CompactionPlan,
    apply_compaction_with_summary,
    try_fold_hydrated_transcript,
)
from evoflow.agents.context_compaction_core import ContextCompactionEngine


def _summary_msg(body: str = "folded history") -> HumanMessage:
    from evoflow.agents.context_compaction_core import MAIN_SUMMARY_PREFIX

    return HumanMessage(
        content=f"{MAIN_SUMMARY_PREFIX}\n{body}",
        name="conversation_summary",
    )


def test_try_fold_hydrated_transcript_is_noop() -> None:
    bridge = [HumanMessage(content="old user ask")]
    tail = [AIMessage(content="post compaction assistant")]
    messages = [*bridge, _summary_msg(), *tail]
    assert try_fold_hydrated_transcript(messages, summary=messages[1].content, protect_tail_messages=2) is None


def test_try_fold_hydrated_transcript_noop_without_summary_marker() -> None:
    messages = [HumanMessage(content="user"), AIMessage(content="assistant")]
    assert try_fold_hydrated_transcript(messages, summary="[CONTEXT COMPACTION — REFERENCE ONLY]\nx") is None


def test_apply_compaction_with_summary_keeps_pre_summary_user_bridge() -> None:
    bridge = [
        HumanMessage(content="earlier user ask"),
        HumanMessage(content="later user ask"),
    ]
    tail = [HumanMessage(content="latest user"), AIMessage(content="latest assistant")]
    messages = [*bridge, _summary_msg("summary body"), *tail]
    plan = CompactionPlan(
        working=messages,
        head_end=0,
        compress_end=3,
        middle=[],
        middle_tokens=0,
        original_count=len(messages),
    )
    folded = apply_compaction_with_summary(plan, "[CONTEXT COMPACTION — REFERENCE ONLY]\nrefreshed")
    summary_idx = next(i for i, m in enumerate(folded) if getattr(m, "name", None) == "conversation_summary")
    pre = folded[:summary_idx]
    assert all(isinstance(m, HumanMessage) for m in pre)
    assert "earlier user ask" in str(pre[0].content)
    assert "later user ask" in str(pre[1].content)
    assert "refreshed" in str(folded[summary_idx].content)
    assert any(isinstance(m, HumanMessage) and "latest user" in str(m.content) for m in folded[summary_idx + 1 :])


def test_compress_messages_fast_skips_background_job_when_real_summary_and_cooldown() -> None:
    from evoflow.agents.context_compaction_core import _with_summary_prefix
    from evoflow.persistence import session_repositories as sess_repo
    from evoflow.persistence.chat_message_repositories import persist_conversation_summary
    from evoflow.persistence.db import reset_db_for_tests
    import os
    import tempfile

    td = tempfile.mkdtemp()
    os.environ["EVOFLOW_DB_PATH"] = f"{td}/fold.db"
    reset_db_for_tests()
    sk = "agent:test:no-bg-dup"
    tid = "t-no-bg"
    sess_repo.upsert_session_row(sk, thread_id=tid)
    persist_conversation_summary(
        sk,
        _with_summary_prefix("real summary body"),
        thread_id=tid,
    )

    engine = ContextCompactionEngine()
    text = "word " * 8000
    msgs = []
    for i in range(30):
        msgs.append(HumanMessage(content=f"u{i} {text}"))
        msgs.append(AIMessage(content=f"a{i} {text}"))
    engine.mark_compress_completed(tid, before_gate_tokens=50_000, message_count=len(msgs))

    _, _, job = engine.compress_messages_fast(
        msgs,
        thread_id=tid,
        context_length=100_000,
        compaction_cooldown_seconds=120.0,
        compaction_hysteresis_enabled=True,
        force=True,
    )
    assert job is None
