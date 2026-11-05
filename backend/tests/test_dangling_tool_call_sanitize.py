"""Tool-pair sanitize must drop orphans, stub missing, and fix adjacency (Volc 11148)."""

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


def test_sanitize_pulls_late_tool_result_before_intervening_human() -> None:
    """Compaction often inserts a summary Human between AI tool_calls and ToolMessage."""
    tool = ToolMessage(content="ok", tool_call_id="c1", name="foo")
    messages = [
        HumanMessage(content="hi"),
        AIMessage(content="", tool_calls=[{"id": "c1", "name": "foo", "args": {}}]),
        HumanMessage(content="[conversation summary]"),
        tool,
    ]
    patched = sanitize_tool_call_pairs(messages)
    assert patched is not None
    assert patched[1].type == "ai"
    assert isinstance(patched[2], ToolMessage)
    assert patched[2] is tool
    assert isinstance(patched[3], HumanMessage)
    assert patched[3].content == "[conversation summary]"
    assert sum(1 for m in patched if isinstance(m, ToolMessage)) == 1


def test_sanitize_partial_adjacent_then_late_second_tool() -> None:
    t1 = ToolMessage(content="a", tool_call_id="c1", name="foo")
    t2 = ToolMessage(content="b", tool_call_id="c2", name="bar")
    messages = [
        AIMessage(
            content="",
            tool_calls=[
                {"id": "c1", "name": "foo", "args": {}},
                {"id": "c2", "name": "bar", "args": {}},
            ],
        ),
        t1,
        HumanMessage(content="summary"),
        t2,
    ]
    patched = sanitize_tool_call_pairs(messages)
    assert patched is not None
    assert patched[0].type == "ai"
    assert patched[1] is t1
    assert patched[2] is t2
    assert isinstance(patched[3], HumanMessage)
