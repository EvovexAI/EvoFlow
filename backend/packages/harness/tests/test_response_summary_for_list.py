"""Tests for _summarize_response_for_list tool-call detection."""

from __future__ import annotations

import json

from langchain_core.messages import AIMessage, message_to_dict

from evoflow.observability.queries import _summarize_response_for_list


def _wrap(msg: AIMessage) -> dict:
    return {
        "generations": [[{"type": "ChatGeneration", "text": "", "message": message_to_dict(msg)}]],
        "llm_output": {},
    }


def test_tool_calls_on_message():
    msg = AIMessage(
        content="",
        tool_calls=[{"name": "grep", "args": {"pattern": "foo"}, "id": "1", "type": "tool_call"}],
    )
    summary = _summarize_response_for_list(_wrap(msg))
    assert summary is not None
    assert summary["kind"] == "tools"
    assert summary["has_tools"] is True


def test_tool_calls_in_additional_kwargs_only():
    msg = AIMessage(
        content="",
        additional_kwargs={
            "tool_calls": [
                {
                    "id": "1",
                    "type": "function",
                    "function": {"name": "grep", "arguments": json.dumps({"pattern": "foo"})},
                }
            ]
        },
    )
    summary = _summarize_response_for_list(_wrap(msg))
    assert summary is not None
    assert summary["kind"] == "tools", summary
    assert summary["has_tools"] is True


def test_tool_calls_in_additional_kwargs_wire_format_with_generation_text():
    """Streaming models may leave OpenAI tool_calls only under additional_kwargs."""
    msg = {
        "type": "ai",
        "data": {
            "content": "",
            "additional_kwargs": {
                "tool_calls": [
                    {
                        "id": "call_abc",
                        "type": "function",
                        "function": {"name": "read_file", "arguments": json.dumps({"path": "foo.py"})},
                    }
                ]
            },
            "type": "ai",
            "tool_calls": [],
        },
    }
    resp = {
        "generations": [[{"type": "ChatGeneration", "text": "checking file", "message": msg}]],
        "llm_output": {},
    }
    summary = _summarize_response_for_list(resp)
    assert summary is not None
    assert summary["kind"] == "tools_and_content", summary
    assert summary["has_tools"] is True
    assert "read_file" in summary["tool_names"]


def test_reasoning_blocks_not_counted_as_content_when_only_tools():
    msg = AIMessage(
        content=[{"type": "reasoning", "reasoning": "thinking..."}],
        tool_calls=[{"name": "read", "args": {}, "id": "2", "type": "tool_call"}],
    )
    summary = _summarize_response_for_list(_wrap(msg))
    assert summary is not None
    assert summary["kind"] == "tools", summary


def test_tool_call_chunks_not_detected():
    """Streaming responses store tool_call_chunks instead of tool_calls.

    When a streaming model accumulates chunks, the resulting AIMessageChunk
    has ``tool_call_chunks`` but NOT ``tool_calls``. The summary function
    must check both fields.
    """
    msg = {
        "type": "ai",
        "data": {
            "content": "",
            "additional_kwargs": {},
            "type": "ai",
            "tool_call_chunks": [
                {
                    "name": "web_search",
                    "args": '{"query": "test"}',
                    "id": "call_abc",
                    "index": 0,
                    "type": "tool_call_chunk",
                }
            ],
            "tool_calls": [],
            "invalid_tool_calls": [],
        },
    }
    resp = {
        "generations": [[{"type": "ChatGeneration", "text": "", "message": msg}]],
        "llm_output": {},
    }
    summary = _summarize_response_for_list(resp)
    assert summary is not None
    assert summary["kind"] == "tools", f"Expected 'tools' but got {summary}"
    assert summary["has_tools"] is True
    assert "web_search" in summary["tool_names"]


def test_tool_call_chunks_with_content():
    """Streaming response with both tool_call_chunks and text content."""
    msg = {
        "type": "ai",
        "data": {
            "content": "I will search for that.",
            "additional_kwargs": {},
            "type": "ai",
            "tool_call_chunks": [
                {
                    "name": "web_search",
                    "args": '{"query": "latest news"}',
                    "id": "call_def",
                    "index": 0,
                    "type": "tool_call_chunk",
                }
            ],
            "tool_calls": [],
            "invalid_tool_calls": [],
        },
    }
    resp = {
        "generations": [[{"type": "ChatGeneration", "text": "I will search for that.", "message": msg}]],
        "llm_output": {},
    }
    summary = _summarize_response_for_list(resp)
    assert summary is not None
    assert summary["kind"] == "tools_and_content", f"Expected 'tools_and_content' but got {summary}"
    assert summary["has_tools"] is True
    assert summary["has_content"] is True
    assert "web_search" in summary["tool_names"]
