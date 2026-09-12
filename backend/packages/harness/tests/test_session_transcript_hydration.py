"""Session transcript hydration and content_json body."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage, HumanMessage, RemoveMessage

from evoflow.agents.middlewares import session_transcript_hydration_middleware as hyd_mod
from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
    SessionTranscriptHydrationMiddleware,
    clear_hydration_watermark_cache,
    lead_transcript_rows_to_lc_messages,
)
from evoflow.persistence.chat_message_content import flatten_display_segments_text
from evoflow.persistence.chat_message_repositories import (
    append_message,
    persist_conversation_summary,
)
from evoflow.persistence.db import reset_db_for_tests
from evoflow.persistence.pending_inject_repository import enqueue_pending_inject


@pytest.fixture
def chat_db(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "hydrate_cache.db"))
    monkeypatch.setenv("EVOFLOW_HYDRATION_CACHE", "1")
    reset_db_for_tests()
    clear_hydration_watermark_cache()
    yield tmp_path
    clear_hydration_watermark_cache()
    reset_db_for_tests()


def _patch_session_resolution(monkeypatch: pytest.MonkeyPatch, session_key: str, thread_id: str = "tid-hydrate") -> None:
    monkeypatch.setattr(hyd_mod, "_thread_id_from_runtime", lambda _r: thread_id)
    monkeypatch.setattr(hyd_mod, "_session_key_for_thread", lambda _t: session_key)
    monkeypatch.setattr(hyd_mod, "_proactive_duty_round_id", lambda _r, _sk: None)


def _id_of(m) -> str:
    return str(getattr(m, "id", None) or "").strip()


def test_flatten_display_segments_text() -> None:
    segs = [{"kind": "text", "text": "partial line 1"}, {"kind": "tools", "ids": ["t1"]}]
    assert flatten_display_segments_text(json.dumps(segs)) == "partial line 1"


def test_lead_transcript_rows_partial_abort_segments() -> None:
    rows = [
        {"role": "user", "content_json": '{"content":"hi"}', "message_id": "u1"},
        {
            "role": "assistant",
            "content_json": json.dumps({"content": "half answer"}),
            "message_id": "partial-abort-run-1",
        },
        {"role": "user", "content_json": '{"content":"continue"}', "message_id": "u2"},
    ]
    lc = lead_transcript_rows_to_lc_messages(rows)
    assert len(lc) == 3
    assert lc[1].content == "half answer"


def test_lead_transcript_rows_tool_calls_in_content_json() -> None:
    rows = [
        {
            "role": "assistant",
            "content_json": json.dumps(
                {
                    "content": "好的，我来询问",
                    "tool_calls": [{"id": "tc1", "name": "ask_clarification", "args": {"title": "确认"}}],
                }
            ),
            "message_id": "a-ask",
        },
    ]
    lc = lead_transcript_rows_to_lc_messages(rows)
    assert len(lc) == 1
    assert lc[0].tool_calls
    assert lc[0].tool_calls[0]["name"] == "ask_clarification"


def test_lead_transcript_rows_to_lc_messages_tool_and_assistant() -> None:
    rows = [
        {"role": "user", "content_json": '{"content":"hello"}', "message_id": "u1"},
        {
            "role": "assistant",
            "content_json": '{"content":"","tool_calls":[{"id":"tc1","name":"read_file","args":{}}]}',
            "message_id": "a1",
        },
        {
            "role": "tool",
            "content_json": '{"content":"file body"}',
            "message_id": "t1",
            "tool_call_id": "tc1",
            "tool_name": "read_file",
        },
    ]
    lc = lead_transcript_rows_to_lc_messages(rows)
    assert len(lc) == 3
    assert lc[1].tool_calls[0]["name"] == "read_file"  # type: ignore[attr-defined]
    assert lc[2].content == "file body"


def test_hydration_cache_skips_second_before_model(chat_db, monkeypatch: pytest.MonkeyPatch) -> None:
    sk = "agent:main:hydrate-cache-skip"
    _patch_session_resolution(monkeypatch, sk)
    append_message(sk, role="user", content="hello", message_id="u1")
    append_message(sk, role="assistant", content="world", message_id="a1")

    calls = {"n": 0}
    orig = hyd_mod.list_lead_chat_rows_for_model_hydration

    def counting(*args, **kwargs):
        calls["n"] += 1
        return orig(*args, **kwargs)

    monkeypatch.setattr(hyd_mod, "list_lead_chat_rows_for_model_hydration", counting)

    mw = SessionTranscriptHydrationMiddleware()
    runtime = MagicMock()
    state = {"messages": [HumanMessage(content="hello", id="u1"), AIMessage(content="world", id="a1")]}

    first = mw.before_model(state, runtime)
    assert first is not None
    assert calls["n"] >= 1
    first_calls = calls["n"]

    second = mw.before_model(state, runtime)
    assert second is None
    assert calls["n"] == first_calls


def test_hydration_cache_miss_on_pending_inject(chat_db, monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.persistence.pending_inject_repository import clear_pending_inject_store_for_tests

    clear_pending_inject_store_for_tests()
    sk = "agent:main:hydrate-cache-inject"
    _patch_session_resolution(monkeypatch, sk)
    append_message(sk, role="user", content="hello", message_id="u1")
    append_message(sk, role="assistant", content="world", message_id="a1")

    mw = SessionTranscriptHydrationMiddleware()
    runtime = MagicMock()
    state = {"messages": [HumanMessage(content="hello", id="u1")]}
    assert mw.before_model(state, runtime) is not None

    calls = {"n": 0}
    orig = hyd_mod.list_lead_chat_rows_for_model_hydration

    def counting(*args, **kwargs):
        calls["n"] += 1
        return orig(*args, **kwargs)

    monkeypatch.setattr(hyd_mod, "list_lead_chat_rows_for_model_hydration", counting)

    enqueue_pending_inject(sk, message_id="u-inject", content="steer now", role="user")
    patch = mw.before_model(state, runtime)
    assert patch is not None
    assert calls["n"] >= 1
    msgs = [m for m in patch["messages"] if not isinstance(m, RemoveMessage)]
    human_texts = [
        str(getattr(m, "content", "") or "")
        for m in msgs
        if isinstance(m, HumanMessage)
    ]
    assert any("steer now" in t for t in human_texts)


def test_hydration_cache_miss_on_compaction(chat_db, monkeypatch: pytest.MonkeyPatch) -> None:
    sk = "agent:main:hydrate-cache-compact"
    _patch_session_resolution(monkeypatch, sk)
    append_message(sk, role="user", content="old", message_id="u-old")
    append_message(sk, role="assistant", content="reply", message_id="a-old")

    mw = SessionTranscriptHydrationMiddleware()
    runtime = MagicMock()
    state = {"messages": [HumanMessage(content="old", id="u-old")]}
    assert mw.before_model(state, runtime) is not None

    calls = {"n": 0}
    orig = hyd_mod.list_lead_chat_rows_for_model_hydration

    def counting(*args, **kwargs):
        calls["n"] += 1
        return orig(*args, **kwargs)

    monkeypatch.setattr(hyd_mod, "list_lead_chat_rows_for_model_hydration", counting)

    persist_conversation_summary(sk, "summary of prior turns")
    append_message(sk, role="user", content="new after compact", message_id="u-new")
    patch = mw.before_model(
        {"messages": [HumanMessage(content="new after compact", id="u-new")]},
        runtime,
    )
    assert patch is not None
    assert calls["n"] >= 1


def test_hydration_merges_in_flight_human_not_yet_in_db(chat_db, monkeypatch: pytest.MonkeyPatch) -> None:
    sk = "agent:main:hydrate-merge-human"
    _patch_session_resolution(monkeypatch, sk)
    append_message(sk, role="user", content="prior", message_id="u0")
    append_message(sk, role="assistant", content="ok", message_id="a0")

    mw = SessionTranscriptHydrationMiddleware()
    runtime = MagicMock()
    state = {
        "messages": [
            HumanMessage(content="prior", id="u0"),
            AIMessage(content="ok", id="a0"),
            HumanMessage(content="brand new turn", id="u-inflight"),
        ]
    }
    patch = mw.before_model(state, runtime)
    assert patch is not None
    msgs = [m for m in patch["messages"] if not isinstance(m, RemoveMessage)]
    assert any(isinstance(m, HumanMessage) and _id_of(m) == "u-inflight" for m in msgs)
    assert any(isinstance(m, HumanMessage) and str(m.content) == "brand new turn" for m in msgs)


def test_hydration_cache_disabled_always_reloads(chat_db, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_HYDRATION_CACHE", "0")
    clear_hydration_watermark_cache()
    sk = "agent:main:hydrate-cache-off"
    _patch_session_resolution(monkeypatch, sk)
    append_message(sk, role="user", content="hello", message_id="u1")

    calls = {"n": 0}
    orig = hyd_mod.list_lead_chat_rows_for_model_hydration

    def counting(*args, **kwargs):
        calls["n"] += 1
        return orig(*args, **kwargs)

    monkeypatch.setattr(hyd_mod, "list_lead_chat_rows_for_model_hydration", counting)

    mw = SessionTranscriptHydrationMiddleware()
    runtime = MagicMock()
    state = {"messages": [HumanMessage(content="hello", id="u1")]}
    assert mw.before_model(state, runtime) is not None
    n1 = calls["n"]
    assert mw.before_model(state, runtime) is not None
    assert calls["n"] > n1


def test_collect_missing_state_humans_skips_when_ids_align() -> None:
    from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
        _collect_missing_state_humans,
    )

    db_lc = [HumanMessage(content="哈哈哈 你再检查下", id="user-optimistic-1")]
    state = [
        HumanMessage(content="哈哈哈 你再检查下", id="user-optimistic-1"),
        HumanMessage(content="哈哈哈 你再检查下", id="lg-auto-different"),
    ]
    # Same text already in DB → never re-merge (checkpoint id mismatch is ignored).
    missing = _collect_missing_state_humans(db_lc, state)
    assert missing == []


def test_collect_missing_state_humans_only_latest_in_flight() -> None:
    from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
        _collect_missing_state_humans,
    )

    db_lc = [HumanMessage(content="old ask", id="u-old")]
    state = [
        HumanMessage(content="old ask", id="stale-lg-1"),
        HumanMessage(content="another old", id="stale-lg-2"),
        HumanMessage(content="brand new ask", id="lg-inflight"),
    ]
    missing = _collect_missing_state_humans(db_lc, state)
    assert len(missing) == 1
    assert _id_of(missing[0]) == "lg-inflight"
    assert str(missing[0].content) == "brand new ask"


def test_collect_missing_state_humans_skips_stale_checkpoint_after_compaction() -> None:
    """Post-compact DB hydration must not resurrect humans from a stale LangGraph checkpoint."""
    from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
        _collect_missing_state_humans,
    )

    db_lc = [
        HumanMessage(content="[CONTEXT COMPACTION — REFERENCE ONLY]\nfolded", name="conversation_summary"),
        HumanMessage(content="latest ask", id="u-latest"),
    ]
    stale_state = [
        HumanMessage(content="old ask from checkpoint", id="stale-1"),
        HumanMessage(content="another old ask", id="stale-2"),
        HumanMessage(content="latest ask", id="lg-different-id"),
    ]
    assert _collect_missing_state_humans(db_lc, stale_state) == []


def test_before_model_no_duplicate_when_input_id_matches_transcript(
    chat_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    sk = "agent:main:hydrate-id-align"
    append_message(sk, role="user", content="哈哈哈 你再检查下", message_id="user-optimistic-1")
    clear_hydration_watermark_cache()
    _patch_session_resolution(monkeypatch, sk, thread_id="tid-id-align")

    mw = SessionTranscriptHydrationMiddleware()
    runtime = MagicMock()
    state = {"messages": [HumanMessage(content="哈哈哈 你再检查下", id="user-optimistic-1")]}
    out = mw.before_model(state, runtime)
    assert out is not None
    humans = [
        m
        for m in (out.get("messages") or [])
        if isinstance(m, HumanMessage)
        and str(getattr(m, "content", "") or "").strip() == "哈哈哈 你再检查下"
    ]
    assert len(humans) == 1
    assert _id_of(humans[0]) == "user-optimistic-1"


def test_before_model_no_duplicate_when_input_id_mismatches_transcript(
    chat_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """DB is SSOT: LG-auto id ≠ transcript id must not duplicate the same user text."""
    sk = "agent:main:hydrate-id-mismatch"
    append_message(sk, role="user", content="哈哈哈 你再检查下", message_id="user-optimistic-1")
    clear_hydration_watermark_cache()
    _patch_session_resolution(monkeypatch, sk, thread_id="tid-id-mismatch")

    mw = SessionTranscriptHydrationMiddleware()
    runtime = MagicMock()
    state = {"messages": [HumanMessage(content="哈哈哈 你再检查下", id="lg-auto-different")]}
    out = mw.before_model(state, runtime)
    assert out is not None
    humans = [
        m
        for m in (out.get("messages") or [])
        if isinstance(m, HumanMessage)
        and str(getattr(m, "content", "") or "").strip() == "哈哈哈 你再检查下"
    ]
    assert len(humans) == 1
    assert _id_of(humans[0]) == "user-optimistic-1"


def test_prime_hydration_cache_for_session(chat_db, monkeypatch: pytest.MonkeyPatch) -> None:
    sk = "agent:main:prime-hydration"
    append_message(sk, role="user", content="hello", message_id="u1")
    append_message(sk, role="assistant", content="world", message_id="a1")
    clear_hydration_watermark_cache()

    from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
        prime_hydration_cache_for_session,
    )

    result = prime_hydration_cache_for_session(sk, thread_id="tid-prime")
    assert result["ok"] is True
    assert result["primed"] is True
    assert int(result["dbMsgs"]) >= 2
    assert int(result["maxSeq"]) >= 2

    # Primed watermark → before_model with same humans should skip list/load.
    _patch_session_resolution(monkeypatch, sk, thread_id="tid-prime")
    calls = {"n": 0}
    orig = hyd_mod.list_lead_chat_rows_for_model_hydration

    def counting(*args, **kwargs):
        calls["n"] += 1
        return orig(*args, **kwargs)

    monkeypatch.setattr(hyd_mod, "list_lead_chat_rows_for_model_hydration", counting)
    mw = SessionTranscriptHydrationMiddleware()
    runtime = MagicMock()
    state = {"messages": [HumanMessage(content="hello", id="u1"), AIMessage(content="world", id="a1")]}
    assert mw.before_model(state, runtime) is None
    assert calls["n"] == 0


def test_hydration_trust_runtime_skips_when_watermark_advances(
    chat_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """runtime hot path: new user append must not force full SQLite reload."""
    sk = "agent:main:hydrate-trust-runtime"
    _patch_session_resolution(monkeypatch, sk)
    append_message(sk, role="user", content="hello", message_id="u1")
    append_message(sk, role="assistant", content="world", message_id="a1")

    calls = {"n": 0}
    orig = hyd_mod.list_lead_chat_rows_for_model_hydration

    def counting(*args, **kwargs):
        calls["n"] += 1
        return orig(*args, **kwargs)

    monkeypatch.setattr(hyd_mod, "list_lead_chat_rows_for_model_hydration", counting)

    mw = SessionTranscriptHydrationMiddleware()
    runtime = MagicMock()
    state1 = {
        "messages": [HumanMessage(content="hello", id="u1"), AIMessage(content="world", id="a1")]
    }
    assert mw.before_model(state1, runtime) is not None
    first_calls = calls["n"]
    assert first_calls >= 1

    append_message(sk, role="user", content="follow up", message_id="u2")
    state2 = {
        "messages": [
            HumanMessage(content="hello", id="u1"),
            AIMessage(content="world", id="a1"),
            HumanMessage(content="follow up", id="u2"),
        ]
    }
    assert mw.before_model(state2, runtime) is None
    assert calls["n"] == first_calls
