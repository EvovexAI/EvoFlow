"""Partial tool-call args streaming: each token-level chunk must NOT raise.

Real-world scenario: when the model streams a tool_call, ``function.arguments``
arrives in small chunks (sometimes single characters). Each intermediate
state is a half-JSON string like ``{"path":"out`` and any ``json.loads`` on
it would raise. Regression test for sse_tool_error class of bug.
"""

from __future__ import annotations

from typing import Any

from app.gateway.sse_ui_normalize import UiStreamNormalizer


def _messages_chunk_frame(tool_call_chunks: list[dict[str, Any]]) -> dict[str, Any]:
    """Synthesize a LangGraph ``messages``-tuple style frame carrying chunks."""
    return [
        {
            "type": "AIMessageChunk",
            "id": "ai-stream-1",
            "content": "",
            "tool_call_chunks": tool_call_chunks,
            "additional_kwargs": {},
        },
        {"langgraph_node": "agent"},
    ]


def test_tools_node_ai_chunks_do_not_emit_user_text_delta():
    """Nested tool LLM (view_image vision) streams AIMessageChunk on tools node — not user reply."""

    norm = UiStreamNormalizer(user_input="describe image", anchored=True, allow_tuple_tools=True)

    vision_frames = [
        {
            "type": "AIMessageChunk",
            "id": "vision-stream-1",
            "content": "画面中央有一只橘猫",
            "additional_kwargs": {},
        },
        {"langgraph_node": "tools"},
    ]
    out = norm.feed_frame("messages", vision_frames)
    joined = b"".join(out).decode("utf-8", errors="ignore")
    assert "画面中央有一只橘猫" not in joined
    assert '"type": "delta"' not in joined

    agent_frames = [
        {
            "type": "AIMessageChunk",
            "id": "agent-stream-1",
            "content": "好的，图里是一只猫。",
            "additional_kwargs": {},
        },
        {"langgraph_node": "agent"},
    ]
    out_agent = norm.feed_frame("messages", agent_frames)
    joined_agent = b"".join(out_agent).decode("utf-8", errors="ignore")
    assert "好的，图里是一只猫" in joined_agent
    assert '"type": "delta"' in joined_agent


def test_partial_tool_arguments_at_every_token_boundary_does_not_raise():
    """Feed a single tool_call's arguments one character at a time — every
    intermediate ``feed_frame`` call must succeed without raising."""

    norm = UiStreamNormalizer(user_input="stream tool call", anchored=True, allow_tuple_tools=True)

    final_args = '{"path":"outputs/demo.txt","content":"hello\\nworld","old_string":""}'

    accumulated = ""
    for i, ch in enumerate(final_args):
        accumulated += ch
        chunk = {
            "index": 0,
            "id": "call_partial_1",
            "name": "write_to_file",
            "function": {"name": "write_to_file", "arguments": accumulated},
            "args": accumulated,  # langgraph-tuple shape sometimes also carries args=str
        }
        frame = _messages_chunk_frame([chunk])
        # Must not raise on ANY prefix (most are invalid JSON).
        try:
            norm.feed_frame("messages", frame)
        except Exception as exc:  # pragma: no cover — failure means stream would break
            raise AssertionError(
                f"feed_frame raised at prefix #{i + 1}={accumulated!r}: "
                f"{exc.__class__.__name__}: {exc}"
            ) from exc

    # Final state should have a coherent path so the wire frame is usable.
    # Sanity: the normalizer should have recorded the path field somewhere.
    state = norm.write_tool_wire_state
    assert state, "expected write_tool_wire_state to be populated after streaming"
    any_recorded_path = any(v.get("path") for v in state.values() if isinstance(v, dict))
    assert any_recorded_path, f"no path captured from streamed args; state={state!r}"


def test_partial_args_with_pathological_payloads_does_not_raise():
    """Adversarial half-JSON payloads must not crash feed_frame either."""

    norm = UiStreamNormalizer(user_input="pathological", anchored=True, allow_tuple_tools=True)

    pathological_args = [
        "",  # empty
        "{",  # single brace
        '{"path":',  # key without value
        '{"path":"out',  # mid-string
        '{"path":"a","content":"he\\',  # mid-escape
        '{"path":"a","content":"l1\\nl',  # mid-newline-escape
        "not json at all",  # nonsense
        "{nested:{broken:",  # malformed
        '{"path":null,"content":42}',  # wrong types
        '{"path":"a"',  # missing closing brace
    ]

    for i, raw in enumerate(pathological_args):
        chunk = {
            "index": 0,
            "id": f"call_path_{i}",
            "name": "write_to_file",
            "function": {"name": "write_to_file", "arguments": raw},
        }
        frame = _messages_chunk_frame([chunk])
        try:
            norm.feed_frame("messages", frame)
        except Exception as exc:  # pragma: no cover
            raise AssertionError(
                f"feed_frame raised on pathological args #{i}={raw!r}: "
                f"{exc.__class__.__name__}: {exc}"
            ) from exc


def test_partial_args_across_full_run_does_not_terminate_stream():
    """End-to-end: anchor + streamed tool_call chunks + tool_result + final assistant."""

    norm = UiStreamNormalizer(user_input="full run", anchored=True, allow_tuple_tools=True)

    # Stream tool_call args in 3 chunks.
    for partial in ['{"path":"a', '/b.txt","content":"l', 'ine1\\nline2"}']:
        accumulated = partial  # imitating "additive" wire (langgraph delta semantics)
        chunk = {
            "index": 0,
            "id": "call_e2e",
            "name": "write_to_file",
            "function": {"name": "write_to_file", "arguments": accumulated},
        }
        out = norm.feed_frame("messages", _messages_chunk_frame([chunk]))
        # Each chunk must produce at least a valid bytes list (no raise).
        assert isinstance(out, list)

    # Now feed a complete tool result row that closes the loop.
    tool_result_frame = [
        {
            "type": "tool",
            "id": "tr-1",
            "tool_call_id": "call_e2e",
            "name": "write_to_file",
            "content": "ok",
            "status": "ok",
        },
        {"langgraph_node": "tools"},
    ]
    # also anchor + emit (sanity that follow-up frame still flows).
    final_assistant_frame = [
        {
            "type": "AIMessageChunk",
            "id": "ai-final",
            "content": "Done writing.",
            "additional_kwargs": {},
        },
        {"langgraph_node": "agent"},
    ]

    # Register tool_call_id so the tool_result is emitted (matches real normalizer guard).
    norm.emitted_tool_call_ids.add("call_e2e")

    out_tool = norm.feed_frame("messages", tool_result_frame)
    out_final = norm.feed_frame("messages", final_assistant_frame)

    joined = b"".join(out_tool + out_final).decode("utf-8", errors="ignore")
    # tool_result should be visible somewhere.
    assert "tool_result" in joined or "Done writing" in joined, (
        f"expected post-tool frames to flow through; got: {joined[:600]!r}"
    )
