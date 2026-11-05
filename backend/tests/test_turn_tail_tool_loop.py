"""Turn-tail footers must not re-append during tool-loop model calls."""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from evoflow.agents.message_analysis_utils import should_inject_turn_tail
from evoflow.agents.middlewares.kb_injection_middleware import (
    _KB_INJECTION_MESSAGE_NAME,
    _latest_real_human_index,
    place_kb_after_latest_user,
)


def test_should_inject_on_fresh_user_turn():
    msgs = [HumanMessage(content="改一下出题页")]
    assert should_inject_turn_tail(msgs) is True


def test_should_skip_after_tool_result():
    msgs = [
        HumanMessage(content="改一下出题页"),
        AIMessage(content="", tool_calls=[{"id": "c1", "name": "bash", "args": {}}]),
        ToolMessage(content="ok", tool_call_id="c1"),
    ]
    assert should_inject_turn_tail(msgs) is False


def test_should_inject_ignores_synthetic_tail():
    msgs = [
        HumanMessage(content="改一下出题页"),
        HumanMessage(content="<session_intent>…</session_intent>", name="session_intent"),
        HumanMessage(content="<knowledge_context>…</knowledge_context>", name=_KB_INJECTION_MESSAGE_NAME),
    ]
    assert should_inject_turn_tail(msgs) is True


def test_kb_placement_skips_session_intent_anchor():
    """Regression: session_intent must not become the latest-user anchor."""
    user = HumanMessage(content="资料列表对不上")
    ai = AIMessage(content="", tool_calls=[{"id": "c1", "name": "bash", "args": {}}])
    tool = ToolMessage(content="docs: 0", tool_call_id="c1")
    intent = HumanMessage(content="<session_intent>old goals</session_intent>", name="session_intent")
    kb = HumanMessage(content="<knowledge_context>noise</knowledge_context>", name=_KB_INJECTION_MESSAGE_NAME)

    # If intent were treated as real user, KB would sit after tools (list end).
    out = place_kb_after_latest_user([user, ai, tool, intent], kb)
    assert _latest_real_human_index(out) == 0
    assert getattr(out[1], "name", None) == _KB_INJECTION_MESSAGE_NAME
    # KB sits right after the real user — before AI/tool — not after session_intent.
    assert out.index(out[1]) < out.index(ai)
    assert out.index(out[1]) < out.index(tool)
