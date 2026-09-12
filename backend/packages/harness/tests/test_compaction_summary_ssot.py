"""Compaction summary single-SSOT: evoflow_chat_messages read/write/update only."""

from __future__ import annotations

import pytest

from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.chat_message_repositories import (
    _find_pre_compaction_anchor_seq,
    _is_real_user_transcript_row,
    _prune_stale_compaction_summary_rows,
    append_message,
    find_latest_compaction_seq,
    list_lead_chat_rows_for_model_hydration,
    load_conversation_summary_text,
    persist_conversation_summary,
)


from evoflow.persistence.db import reset_db_for_tests


@pytest.fixture
def chat_db(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "compaction_ssot.db"))
    reset_db_for_tests()
    return tmp_path


def test_persist_conversation_summary_appends_each_compress(chat_db) -> None:
    sk = "agent:test:ssot-append"
    sess_repo.upsert_session_row(sk, thread_id="t-ssot")
    first = persist_conversation_summary(sk, "[CONTEXT COMPACTION — REFERENCE ONLY]\nversion one")
    assert first is not None
    seq1 = int(first["seq"])
    second = persist_conversation_summary(
        sk,
        "[CONTEXT COMPACTION — REFERENCE ONLY]\nversion two",
        force_write=True,
    )
    assert second is not None
    seq2 = int(second["seq"])
    assert seq2 > seq1
    assert find_latest_compaction_seq(sk) == seq2
    assert "version two" in (load_conversation_summary_text(sk) or "")


def test_persist_conversation_summary_sets_unique_message_id(chat_db) -> None:
    sk = "agent:test:ssot-msgid"
    sess_repo.upsert_session_row(sk, thread_id="t-msgid")
    first = persist_conversation_summary(
        sk,
        "[CONTEXT COMPACTION — REFERENCE ONLY]\nv1",
        thread_id="t-msgid",
        force_write=True,
    )
    second = persist_conversation_summary(
        sk,
        "[CONTEXT COMPACTION — REFERENCE ONLY]\nv2",
        thread_id="t-msgid",
        force_write=True,
    )
    assert first is not None and second is not None
    assert first.get("message_id")
    assert second.get("message_id")
    assert first["message_id"] != second["message_id"]
    assert str(first["message_id"]).startswith("compaction-summary:")


def test_hydration_post_tail_empty_when_summary_appended_at_end(chat_db) -> None:
    """Re-compress must append marker at tail so post_tail_rows is not the whole session."""
    sk = "agent:test:append-tail"
    tid = "t-append-tail"
    sess_repo.upsert_session_row(sk, thread_id=tid)
    for i in range(20):
        append_message(sk, role="assistant", content=f"a{i}", thread_id=tid, message_id=f"a{i}")
        append_message(sk, role="tool", content=f"t{i}", thread_id=tid, tool_call_id=f"tc{i}", tool_name="read")
    first = persist_conversation_summary(sk, "[CONTEXT COMPACTION — REFERENCE ONLY]\nv1", thread_id=tid)
    assert first is not None
    for i in range(20, 30):
        append_message(sk, role="assistant", content=f"a{i}", thread_id=tid, message_id=f"a{i}")
        append_message(sk, role="tool", content=f"t{i}", thread_id=tid, tool_call_id=f"tc{i}", tool_name="read")
    second = persist_conversation_summary(
        sk,
        "[CONTEXT COMPACTION — REFERENCE ONLY]\nv2",
        thread_id=tid,
        force_write=True,
    )
    assert second is not None
    assert int(second["seq"]) > int(first["seq"])
    rows = list_lead_chat_rows_for_model_hydration(sk, limit=500)
    assert len(rows) < 40
    assert find_latest_compaction_seq(sk) == int(second["seq"])
    post = [r for r in rows if int(r.get("seq") or 0) > int(second["seq"])]
    assert post == []


def test_prune_stale_compaction_summary_rows_keeps_latest() -> None:
    rows = [
        {"seq": 1, "role": "user", "tool_name": None},
        {"seq": 2, "role": "user", "tool_name": "conversation_summary"},
        {"seq": 3, "role": "assistant", "tool_name": None},
        {"seq": 4, "role": "user", "tool_name": "conversation_summary"},
    ]
    out = _prune_stale_compaction_summary_rows(rows)
    assert [r["seq"] for r in out] == [1, 3, 4]


def test_pre_compaction_anchor_counts_user_turns(chat_db) -> None:
    sk = "agent:test:anchor-rounds"
    tid = "t-anchor"
    sess_repo.upsert_session_row(sk, thread_id=tid)
    append_message(sk, role="user", content="u0", thread_id=tid, message_id="u0")
    append_message(sk, role="assistant", content="a0", thread_id=tid, message_id="a0")
    append_message(sk, role="user", content="u1", thread_id=tid, message_id="u1")
    append_message(sk, role="assistant", content="a1", thread_id=tid, message_id="a1")
    append_message(sk, role="user", content="u2", thread_id=tid, message_id="u2")
    append_message(sk, role="assistant", content="a2", thread_id=tid, message_id="a2")
    append_message(sk, role="user", content="u3", thread_id=tid, message_id="u3")
    append_message(sk, role="assistant", content="a3", thread_id=tid, message_id="a3")
    summary = persist_conversation_summary(
        sk,
        "[CONTEXT COMPACTION — REFERENCE ONLY]\nsummary",
        thread_id=tid,
    )
    assert summary is not None
    compaction_seq = int(summary["seq"])
    anchor = _find_pre_compaction_anchor_seq(sk, compaction_seq, user_turns=3)
    # 4 user turns before summary; keep oldest of last 3 → u1
    from evoflow.persistence.chat_message_repositories import get_db

    anchor_row = get_db().execute(
        "SELECT seq FROM evoflow_chat_messages WHERE session_key = ? AND message_id = ?",
        (sk, "u1"),
    ).fetchone()
    assert anchor_row is not None
    assert anchor == int(anchor_row[0])


def test_hydration_prunes_stale_summary_rows(chat_db) -> None:
    sk = "agent:test:ssot-hydrate"
    tid = "t-hydrate"
    sess_repo.upsert_session_row(sk, thread_id=tid)
    append_message(sk, role="user", content="old user", thread_id=tid)
    append_message(
        sk,
        role="user",
        content="[CONTEXT COMPACTION — REFERENCE ONLY]\nold summary",
        thread_id=tid,
        tool_name="conversation_summary",
    )
    append_message(sk, role="assistant", content="reply", thread_id=tid)
    append_message(
        sk,
        role="user",
        content="[CONTEXT COMPACTION — REFERENCE ONLY]\nnew summary",
        thread_id=tid,
        tool_name="conversation_summary",
    )
    append_message(sk, role="assistant", content="after", thread_id=tid)
    rows = list_lead_chat_rows_for_model_hydration(sk, limit=50)
    summary_rows = [r for r in rows if r.get("tool_name") == "conversation_summary"]
    assert len(summary_rows) == 1
    assert int(summary_rows[0]["seq"]) == 4


def test_user_anchor_prepended_before_compaction_summary(chat_db) -> None:
    """Pre-compaction bridge must retain real user rows (runtime-aligned)."""
    sk = "agent:test:anchor-after-summary"
    tid = "t-anchor-post"
    sess_repo.upsert_session_row(sk, thread_id=tid)
    append_message(sk, role="user", content="real user before bridge", thread_id=tid, message_id="u-old")
    for i in range(3):
        append_message(sk, role="assistant", content=f"a{i}", thread_id=tid, message_id=f"a{i}")
        append_message(sk, role="tool", content=f"t{i}", thread_id=tid, tool_call_id=f"tc{i}", tool_name="read")
    summary = persist_conversation_summary(
        sk,
        "[CONTEXT COMPACTION — REFERENCE ONLY]\nsummary",
        thread_id=tid,
    )
    assert summary is not None
    append_message(sk, role="user", content="post user", thread_id=tid, message_id="u-post")
    append_message(sk, role="assistant", content="post", thread_id=tid, message_id="a-post")
    append_message(sk, role="tool", content="post tool", thread_id=tid, tool_call_id="tc-post", tool_name="read")
    rows = list_lead_chat_rows_for_model_hydration(sk, limit=50)
    summary_idx = next(i for i, r in enumerate(rows) if r.get("tool_name") == "conversation_summary")
    pre = rows[:summary_idx]
    pre_users = [r for r in pre if _is_real_user_transcript_row(r)]
    assert len(pre_users) == 1
    assert pre_users[0].get("message_id") == "u-old"
    assert not any(r.get("role") == "assistant" for r in pre)
    post = rows[summary_idx + 1 :]
    assert [r.get("message_id") for r in post if _is_real_user_transcript_row(r)] == ["u-post"]


def test_post_compaction_tail_is_complete_db_stitch(chat_db) -> None:
    """Each new post-compaction row must appear in hydration (no sliding tail window)."""
    sk = "agent:test:post-tail-stitch"
    tid = "t-post-tail"
    sess_repo.upsert_session_row(sk, thread_id=tid)
    append_message(sk, role="assistant", content="a0", thread_id=tid, message_id="a0")
    summary = persist_conversation_summary(
        sk,
        "[CONTEXT COMPACTION — REFERENCE ONLY]\nsummary",
        thread_id=tid,
    )
    assert summary is not None
    append_message(sk, role="assistant", content="post1", thread_id=tid, message_id="p1")
    rows_after_one = list_lead_chat_rows_for_model_hydration(sk, limit=50)
    summary_idx = next(i for i, r in enumerate(rows_after_one) if r.get("tool_name") == "conversation_summary")
    post1 = rows_after_one[summary_idx + 1 :]
    assert [r.get("message_id") for r in post1] == ["p1"]

    append_message(sk, role="assistant", content="post2", thread_id=tid, message_id="p2")
    append_message(sk, role="tool", content="t2", thread_id=tid, tool_call_id="tc2", tool_name="read")
    rows_after_two = list_lead_chat_rows_for_model_hydration(sk, limit=50)
    summary_idx = next(i for i, r in enumerate(rows_after_two) if r.get("tool_name") == "conversation_summary")
    post2 = rows_after_two[summary_idx + 1 :]
    assert len(post2) == 3
    assert post2[0].get("message_id") == "p1"
    assert post2[1].get("message_id") == "p2"
    assert post2[2].get("role") == "tool"


def test_hydration_loads_post_compaction_forward_not_sliding(chat_db) -> None:
    """Rows after summary must accumulate chronologically, not rotate out as tail grows."""
    sk = "agent:test:forward-hydrate"
    tid = "t-forward"
    sess_repo.upsert_session_row(sk, thread_id=tid)
    append_message(sk, role="assistant", content="bridge", thread_id=tid, message_id="bridge")
    summary = persist_conversation_summary(
        sk,
        "[CONTEXT COMPACTION — REFERENCE ONLY]\nsummary",
        thread_id=tid,
    )
    assert summary is not None
    for i in range(25):
        append_message(sk, role="assistant", content=f"post-{i}", thread_id=tid, message_id=f"p{i}")
    rows = list_lead_chat_rows_for_model_hydration(sk, limit=500)
    summary_idx = next(i for i, r in enumerate(rows) if r.get("tool_name") == "conversation_summary")
    post_ids = [r.get("message_id") for r in rows[summary_idx + 1 :]]
    assert post_ids == [f"p{i}" for i in range(25)]


def test_compress_messages_rehydrates_from_db_after_persist(chat_db, monkeypatch) -> None:
    """Post-compress model payload must match next-round ``before_model`` hydration."""
    import asyncio

    from evoflow.agents.context_compaction_core import ContextCompactionEngine, message_content_str
    from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
        load_model_messages_for_session,
    )
    from evoflow.config.summarization_config import SummarizationConfig, set_summarization_config

    sk = "agent:test:post-compress-rehydrate"
    tid = "t-rehydrate"
    sess_repo.upsert_session_row(sk, thread_id=tid)
    set_summarization_config(
        SummarizationConfig(
            enabled=True,
            protect_first_n=0,
            protect_tail_messages=4,
            compaction_trigger_message_count=2,
        )
    )
    append_message(sk, role="user", content="start task", thread_id=tid, message_id="u0")
    for i in range(8):
        append_message(sk, role="assistant", content=f"assistant {i}" * 80, thread_id=tid, message_id=f"a{i}")
        append_message(
            sk,
            role="tool",
            content=f"tool output {i}" * 120,
            thread_id=tid,
            tool_call_id=f"tc{i}",
            tool_name="read",
        )

    engine = ContextCompactionEngine()

    async def _fake_summary(*_a, **_k):
        return "compressed body for rehydrate test"

    monkeypatch.setattr(engine, "_generate_summary", _fake_summary)

    msgs = load_model_messages_for_session(sk)
    compressed, changed = asyncio.run(
        engine.compress_messages(
            msgs,
            thread_id=tid,
            context_length=8_000,
            threshold_ratio=0.10,
            force=True,
            session_key=sk,
        )
    )
    assert changed is True
    expected = load_model_messages_for_session(sk)
    assert len(expected) > 0
    assert [type(m).__name__ for m in compressed] == [type(m).__name__ for m in expected]
    assert [message_content_str(m) for m in compressed] == [message_content_str(m) for m in expected]


def test_pre_compaction_bridge_keeps_user_rows(chat_db) -> None:
    """Bridge rows must be real user turns only — assistant/tool hops belong in post tail."""
    sk = "agent:test:bridge-no-user"
    tid = "t-bridge"
    from evoflow.persistence import session_repositories as sess_repo

    sess_repo.upsert_session_row(sk, thread_id=tid)
    append_message(sk, role="user", content="old user ask", thread_id=tid, message_id="u-old")
    append_message(sk, role="assistant", content="a0", thread_id=tid, message_id="a0")
    append_message(sk, role="tool", content="t0", thread_id=tid, tool_call_id="tc0", tool_name="read")
    append_message(sk, role="user", content="latest user ask", thread_id=tid, message_id="u-latest")
    append_message(sk, role="assistant", content="a1", thread_id=tid, message_id="a1")
    summary = persist_conversation_summary(
        sk,
        "[CONTEXT COMPACTION — REFERENCE ONLY]\nfolded",
        thread_id=tid,
        force_write=True,
    )
    assert summary is not None
    rows = list_lead_chat_rows_for_model_hydration(sk, limit=500)
    summary_idx = next(i for i, r in enumerate(rows) if r.get("tool_name") == "conversation_summary")
    pre_summary = rows[:summary_idx]
    pre_users = [r for r in pre_summary if _is_real_user_transcript_row(r)]
    assert [r.get("message_id") for r in pre_users] == ["u-old", "u-latest"]
    assert not any(str(r.get("role") or "") == "assistant" for r in pre_summary)


def test_hydration_excludes_stale_summaries_between_anchor_and_latest(chat_db) -> None:
    """Duplicate summary rows before the latest marker must not inflate the bridge."""
    sk = "agent:test:stale-between"
    tid = "t-stale-between"
    from evoflow.persistence import session_repositories as sess_repo

    sess_repo.upsert_session_row(sk, thread_id=tid)
    append_message(sk, role="user", content="u0", thread_id=tid, message_id="u0")
    append_message(sk, role="assistant", content="a0", thread_id=tid, message_id="a0")
    append_message(sk, role="user", content="u1", thread_id=tid, message_id="u1")
    append_message(sk, role="assistant", content="a1", thread_id=tid, message_id="a1")
    old = persist_conversation_summary(sk, "[CONTEXT COMPACTION — REFERENCE ONLY]\nold", thread_id=tid)
    assert old is not None
    append_message(sk, role="user", content="between user", thread_id=tid, message_id="u-between")
    append_message(sk, role="assistant", content="between", thread_id=tid, message_id="a-between")
    new = persist_conversation_summary(sk, "[CONTEXT COMPACTION — REFERENCE ONLY]\nnew", thread_id=tid)
    assert new is not None
    append_message(sk, role="assistant", content="post", thread_id=tid, message_id="a-post")
    rows = list_lead_chat_rows_for_model_hydration(sk, limit=500)
    assert sum(1 for r in rows if r.get("tool_name") == "conversation_summary") == 1
    summary_idx = next(i for i, r in enumerate(rows) if r.get("tool_name") == "conversation_summary")
    pre = rows[:summary_idx]
    assert not any(r.get("tool_name") == "conversation_summary" for r in pre)
    assert int(rows[summary_idx]["seq"]) == int(new["seq"])
    pre_users = [r for r in pre if _is_real_user_transcript_row(r)]
    assert [r.get("message_id") for r in pre_users] == ["u0", "u1", "u-between"]
    post = rows[summary_idx + 1 :]
    assert [r.get("message_id") for r in post if r.get("role") == "assistant"] == ["a-post"]
