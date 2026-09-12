"""Tail read_file / worker outputs capped during compaction planning."""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from evoflow.agents.context_compaction_core import (
    _shrink_oversized_tail_tool_outputs,
    count_text_tokens,
)


def _big_read_file(content_len: int = 80_000) -> ToolMessage:
    return ToolMessage(content="x" * content_len, tool_call_id="tc1", name="read_file")


def test_shrink_oversized_tail_read_file():
    msgs = [
        HumanMessage(content="hi"),
        AIMessage(content="", tool_calls=[{"id": "tc1", "name": "read_file", "args": {}}]),
        _big_read_file(),
    ]
    shrunk = _shrink_oversized_tail_tool_outputs(msgs, tail_start=2)
    assert count_text_tokens(str(shrunk[2].content)) < count_text_tokens("x" * 80_000)
    assert "omitted for context budget" in str(shrunk[2].content)


def test_shrink_skips_non_tail_and_small_tools():
    msgs = [
        HumanMessage(content="hi"),
        _big_read_file(1000),
        AIMessage(content="", tool_calls=[{"id": "tc1", "name": "read_file", "args": {}}]),
        _big_read_file(1000),
    ]
    out = _shrink_oversized_tail_tool_outputs(msgs, tail_start=2)
    assert str(out[1].content) == str(msgs[1].content)
    assert str(out[3].content) == str(msgs[3].content)
