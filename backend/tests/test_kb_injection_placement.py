"""KB injection must sit after the triggering user message, not at list end."""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from evoflow.agents.middlewares.kb_injection_middleware import (
    _KB_INJECTION_MESSAGE_NAME,
    _KbTurnCache,
    _kb_turn_cache,
    _latest_human_preview,
    _latest_real_human_index,
    place_kb_after_latest_user,
)


def test_latest_human_skips_injection_footers():
    messages = [
        HumanMessage(content="hello"),
        HumanMessage(content="<knowledge_context>noise</knowledge_context>", name=_KB_INJECTION_MESSAGE_NAME),
        HumanMessage(content="skill body", name="evf_skill_injection"),
    ]
    assert _latest_human_preview(messages) == "hello"
    assert _latest_real_human_index(messages) == 0


def test_place_kb_after_user_before_tools():
    user = HumanMessage(content="查一下退货政策")
    ai = AIMessage(content="", tool_calls=[{"id": "c1", "name": "web_search", "args": {}}])
    tool = ToolMessage(content="search hits…", tool_call_id="c1")
    skill = HumanMessage(content="skill", name="evf_skill_injection")
    kb = HumanMessage(content="<knowledge_context>政策片段</knowledge_context>", name=_KB_INJECTION_MESSAGE_NAME)

    out = place_kb_after_latest_user([user, ai, tool, skill], kb)

    assert [type(m).__name__ for m in out] == [
        "HumanMessage",
        "HumanMessage",
        "AIMessage",
        "ToolMessage",
        "HumanMessage",
    ]
    assert out[0].content == "查一下退货政策"
    assert getattr(out[1], "name", None) == _KB_INJECTION_MESSAGE_NAME
    assert out[-2].content == "search hits…"
    assert getattr(out[-1], "name", None) == "evf_skill_injection"


def test_place_kb_replaces_stale_end_append():
    """Old bug: KB was appended after tools; re-place must move it after user."""
    user = HumanMessage(content="q")
    ai = AIMessage(content="thinking")
    stale = HumanMessage(content="old kb", name=_KB_INJECTION_MESSAGE_NAME)
    fresh = HumanMessage(content="new kb", name=_KB_INJECTION_MESSAGE_NAME)

    out = place_kb_after_latest_user([user, ai, stale], fresh)
    names = [getattr(m, "name", None) for m in out]
    assert names.count(_KB_INJECTION_MESSAGE_NAME) == 1
    assert out[1].content == "new kb"
    assert out[2].content == "thinking"


def test_turn_cache_survives_tool_round_marker():
    token = _kb_turn_cache.set(
        _KbTurnCache(query="q", context="<knowledge_context>x</knowledge_context>", results=[{"title": "a"}])
    )
    try:
        cached = _kb_turn_cache.get()
        assert cached is not None
        assert cached.query == "q"
        assert "knowledge_context" in cached.context
    finally:
        _kb_turn_cache.reset(token)
