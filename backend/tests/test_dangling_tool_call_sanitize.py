"""Tool-pair sanitize must drop orphans and stub missing results (Volc 11148)."""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from evoflow.agents.middlewares.dangling_tool_call_middleware import sanitize_tool_call_pairs


def test_sanitize_returns_none_when_pairs_match() -> None:
    messages = [
        HumanMessage(content="hi"),
        AIMessage(content="", tool_calls=[{"id": "c1", "name": "foo", "args": {}}]),
        ToolMessage(content="ok", tool_call_id="c1", name="foo"),
    ]
    assert sanitize_tool_call_pairs(messages) is None


def test_sanitize_stubs_missing_tool_result() -> None:
    messages = [
        HumanMessage(content="hi"),
        AIMessage(content="", tool_calls=[{"id": "c1", "name": "foo", "args": {}}]),
        HumanMessage(content="continue"),
    ]
    patched = sanitize_tool_call_pairs(messages)
    assert patched is not None
    assert isinstance(patched[2], ToolMessage)
    assert patched[2].tool_call_id == "c1"
    assert "interrupted" in str(patched[2].content).lower()
    assert isinstance(patched[3], HumanMessage)


def test_sanitize_drops_orphan_tool_result() -> None:
    messages = [
        HumanMessage(content="hi"),
        ToolMessage(content="orphan", tool_call_id="gone", name="foo"),
        HumanMessage(content="again"),
    ]
    patched = sanitize_tool_call_pairs(messages)
    assert patched is not None
    assert len(patched) == 2
    assert all(not isinstance(m, ToolMessage) for m in patched)


def test_sanitize_orphan_and_missing_together() -> None:
    messages = [
        HumanMessage(content="hi"),
        AIMessage(content="", tool_calls=[{"id": "alive", "name": "bar", "args": {}}]),
        ToolMessage(content="orphan", tool_call_id="dead", name="foo"),
    ]
    patched = sanitize_tool_call_pairs(messages)
    assert patched is not None
    tool_msgs = [m for m in patched if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    assert tool_msgs[0].tool_call_id == "alive"
