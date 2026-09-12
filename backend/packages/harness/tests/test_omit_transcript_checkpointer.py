"""Omit transcript channels from durable checkpoint puts."""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from evoflow.agents.checkpointer.omit_transcript import (
    has_unresolved_tool_calls,
    omit_transcript_channels,
)


def test_omit_clears_completed_turn() -> None:
    ck = {
        "channel_values": {
            "messages": [
                HumanMessage(content="hi", id="u1"),
                AIMessage(content="yo", id="a1"),
            ],
            "ui_messages": [{"x": 1}],
            "title": "t",
        }
    }
    out = omit_transcript_channels(ck)
    assert out["channel_values"]["messages"] == []
    assert out["channel_values"]["ui_messages"] == []
    assert out["channel_values"]["title"] == "t"
    assert ck["channel_values"]["messages"]  # original untouched


def test_omit_keeps_unresolved_tool_calls() -> None:
    msgs = [
        HumanMessage(content="do it", id="u1"),
        AIMessage(
            content="",
            id="a1",
            tool_calls=[{"id": "call-1", "name": "bash", "args": {}}],
        ),
    ]
    assert has_unresolved_tool_calls(msgs) is True
    ck = {"channel_values": {"messages": msgs}}
    out = omit_transcript_channels(ck)
    assert out is ck
    assert out["channel_values"]["messages"] is msgs


def test_omit_after_tool_result_resolved() -> None:
    msgs = [
        AIMessage(
            content="",
            id="a1",
            tool_calls=[{"id": "call-1", "name": "bash", "args": {}}],
        ),
        ToolMessage(content="ok", tool_call_id="call-1", id="t1"),
    ]
    assert has_unresolved_tool_calls(msgs) is False
    out = omit_transcript_channels({"channel_values": {"messages": msgs}})
    assert out["channel_values"]["messages"] == []
