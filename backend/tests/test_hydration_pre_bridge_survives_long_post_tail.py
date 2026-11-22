"""Pre-compaction user bridge must survive a long post-summary tool tail.

Paint/CUA turns often compact mid-loop: summary lands, then dozens of
assistant/tool hops append after it. Hydration used to load pre-bridge via
``_list_lead_chat_rows_from_min_seq(anchor, max_want=12)`` which keeps the
*newest* 12 rows with seq>=anchor — once the post-tail grows, every real user
ask falls out of that window and the model only sees summary Goal + orphan
tools (endless 「再画一颗」).
"""

from __future__ import annotations

import pytest


@pytest.fixture()
def probe_db(tmp_path, monkeypatch):
    db_path = tmp_path / "pre_bridge_tail.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence.db import get_db, reset_db_for_tests
    from evoflow.persistence.schema import ensure_app_schema

    reset_db_for_tests()
    ensure_app_schema(get_db())
    yield
    reset_db_for_tests()
    monkeypatch.delenv("EVOFLOW_DB_PATH", raising=False)


def _seed_mid_turn_compaction_with_long_cua_tail(sk: str, tid: str, *, post_hops: int = 40) -> str:
    from evoflow.persistence.chat_message_repositories import append_message, persist_conversation_summary

    append_message(sk, role="user", content="先开 Word 写 200 字。", thread_id=tid)
    append_message(sk, role="assistant", content="好，先写完。", thread_id=tid)
    append_message(sk, role="user", content="再会个小爱心，画板上边，不要矩形框。", thread_id=tid)
    append_message(sk, role="assistant", content="先截一张看看。", thread_id=tid)
    append_message(
        sk,
        role="tool",
        content="[Screenshot captured: /api/threads/t/browser-snapshots/x (10KB)]",
        tool_name="mcp__node_repl__js",
        tool_call_id="tc-pre-1",
        thread_id=tid,
    )
    persist_conversation_summary(
        sk,
        "[CONTEXT COMPACTION — REFERENCE ONLY]\n## Goal\nDraw a small heart and fill it.\n",
        thread_id=tid,
        force_write=True,
    )
    for i in range(post_hops):
        append_message(sk, role="assistant", content=f"再画一颗小爱心 #{i}", thread_id=tid)
        append_message(
            sk,
            role="tool",
            content=f"[Screenshot captured: hop-{i}]",
            tool_name="mcp__node_repl__js",
            tool_call_id=f"tc-post-{i}",
            thread_id=tid,
        )
    return "再会个小爱心，画板上边，不要矩形框。"


def test_pre_bridge_keeps_live_user_when_post_tail_exceeds_old_window(probe_db):
    from evoflow.persistence.chat_message_repositories import (
        _is_real_user_transcript_row,
        list_lead_chat_rows_for_model_hydration,
        plain_text,
        loads_payload,
    )

    sk, tid = "agent:main:pre-bridge", "tid-pre-bridge"
    live_ask = _seed_mid_turn_compaction_with_long_cua_tail(sk, tid, post_hops=40)

    rows = list_lead_chat_rows_for_model_hydration(sk)
    assert rows, "hydration returned empty"

    summary_idxs = [i for i, r in enumerate(rows) if str(r.get("tool_name") or "") == "conversation_summary"]
    assert summary_idxs, "missing conversation_summary in stitch"
    summary_idx = summary_idxs[0]

    pre_users = [r for r in rows[:summary_idx] if _is_real_user_transcript_row(r)]
    assert pre_users, "pre-bridge must keep real user asks before summary"
    texts = [
        plain_text(r.get("payload") if isinstance(r.get("payload"), dict) else loads_payload(str(r.get("content_json") or "")))
        for r in pre_users
    ]
    assert any(live_ask in t for t in texts), f"live ask missing from pre-bridge: {texts!r}"

    # Live ask must not only appear after a long orphan tool trail.
    first_live = next(i for i, r in enumerate(rows) if _is_real_user_transcript_row(r) and live_ask in plain_text(
        r.get("payload") if isinstance(r.get("payload"), dict) else loads_payload(str(r.get("content_json") or ""))
    ))
    assert first_live < summary_idx


def test_anchor_recovers_pre_summary_user_when_bridge_empty(probe_db, monkeypatch):
    """Belt: even if pre_raw were empty, anchor must splice newest pre-summary user."""
    from evoflow.persistence import chat_message_repositories as repo

    sk, tid = "agent:main:anchor-recover", "tid-anchor"
    live_ask = _seed_mid_turn_compaction_with_long_cua_tail(sk, tid, post_hops=5)

    real_filter = repo._filter_pre_compaction_bridge_rows
    monkeypatch.setattr(
        repo,
        "_filter_pre_compaction_bridge_rows",
        lambda rows, *, compaction_seq: [],
    )
    try:
        rows = repo.list_lead_chat_rows_for_model_hydration(sk)
    finally:
        monkeypatch.setattr(repo, "_filter_pre_compaction_bridge_rows", real_filter)

    summary_idx = next(i for i, r in enumerate(rows) if str(r.get("tool_name") or "") == "conversation_summary")
    pre_users = [r for r in rows[:summary_idx] if repo._is_real_user_transcript_row(r)]
    assert len(pre_users) == 1
    text = repo.plain_text(
        pre_users[0].get("payload")
        if isinstance(pre_users[0].get("payload"), dict)
        else repo.loads_payload(str(pre_users[0].get("content_json") or ""))
    )
    assert live_ask in text
