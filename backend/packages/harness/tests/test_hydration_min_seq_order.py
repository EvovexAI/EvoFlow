"""Regression: post-compaction hydration must stay chronological across list_messages pages."""

from __future__ import annotations

import pytest

from evoflow.persistence.chat_message_content import plain_text
from evoflow.persistence.chat_message_repositories import (
    _list_lead_chat_rows_from_min_seq,
    append_message,
)
from evoflow.persistence.db import reset_db_for_tests


@pytest.fixture
def chat_db(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "hydrate_min_seq_order.db"))
    reset_db_for_tests()
    return tmp_path


def test_list_lead_chat_rows_from_min_seq_stays_chronological_across_pages(chat_db, monkeypatch) -> None:
    """When post-compaction span exceeds one list_messages page, seq order must remain ASC.

    list_messages pages DESC-then-reverse-within-page. Concatenating pages without a
    global sort used to put older user turns *after* newer ones — the exact bug that
    made monitoring show a stale「用户最新问题」.
    """
    sk = "agent:test:min-seq-order"
    # Force tiny pages so we cross a page boundary well before max_want.
    import evoflow.persistence.chat_message_repositories as repo

    real_list = repo.list_messages

    def tiny_pages(session_key, **kwargs):
        kwargs = dict(kwargs)
        kwargs["limit"] = min(int(kwargs.get("limit") or 50), 40)
        return real_list(session_key, **kwargs)

    monkeypatch.setattr(repo, "list_messages", tiny_pages)

    old_ask = "OLD_ASK_should_not_be_last"
    new_ask = "NEW_ASK_must_be_last_real_user"
    append_message(sk, role="user", content=old_ask, message_id="u-old")
    # Pad with assistant/tool pairs so min_seq span exceeds one page (40).
    for i in range(60):
        append_message(
            sk,
            role="assistant",
            content=f"a{i}",
            message_id=f"a{i}",
            content_json={
                "content": f"a{i}",
                "tool_calls": [{"id": f"tc{i}", "name": "read_file", "args": {"path": f"/{i}"}}],
            },
        )
        append_message(
            sk,
            role="tool",
            content=f"tool-{i}",
            message_id=f"t{i}",
            tool_call_id=f"tc{i}",
            tool_name="read_file",
        )
    append_message(sk, role="user", content=new_ask, message_id="u-new")

    # min_seq=1: all rows; with tiny pages this crosses page boundaries.
    rows = _list_lead_chat_rows_from_min_seq(sk, 1, max_want=500)
    seqs = [int(r["seq"]) for r in rows]
    assert seqs == sorted(seqs), f"seqs not chronological: {seqs[:5]}...{seqs[-5:]}"

    user_texts: list[str] = []
    for r in rows:
        if str(r.get("role") or "") != "user":
            continue
        if str(r.get("tool_name") or "") == "conversation_summary":
            continue
        payload = r.get("payload") if isinstance(r.get("payload"), dict) else {}
        text = plain_text(payload).strip()
        if text:
            user_texts.append(text)

    assert user_texts[0] == old_ask
    assert user_texts[-1] == new_ask
