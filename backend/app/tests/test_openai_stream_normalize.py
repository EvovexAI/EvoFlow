"""OpenAI chunk stream encoding from EVF normalizer output."""

from __future__ import annotations

import json

from app.gateway.openai_stream_encode import decode_sse_payload
from app.gateway.openai_stream_normalize import OpenAiStreamNormalizer, evf_payload_to_openai_frames


def test_openai_chunk_from_delta():
    frames = evf_payload_to_openai_frames(
        {"type": "delta", "text": "hello"},
        completion_id="chatcmpl-test",
        tool_index_by_id={},
    )
    assert len(frames) == 1
    payload = decode_sse_payload(frames[0])
    assert payload["object"] == "chat.completion.chunk"
    assert payload["choices"][0]["delta"]["content"] == "hello"


def test_openai_chunk_from_delta_with_content_phase():
    frames = evf_payload_to_openai_frames(
        {"type": "delta", "text": "reply", "content_phase": "post_tools"},
        completion_id="chatcmpl-test",
        tool_index_by_id={},
    )
    assert len(frames) == 1
    payload = decode_sse_payload(frames[0])
    assert payload["choices"][0]["delta"]["content"] == "reply"
    assert payload["choices"][0]["delta"]["content_phase"] == "post_tools"


def test_openai_chunk_from_tool_call():
    frames = evf_payload_to_openai_frames(
        {
            "type": "tool_call",
            "tool_calls": [
                {
                    "id": "call_1",
                    "name": "read_file",
                    "function": {"name": "read_file", "arguments": "{}"},
                }
            ],
        },
        completion_id="chatcmpl-test",
        tool_index_by_id={},
    )
    assert frames
    payload = decode_sse_payload(frames[0])
    tc = payload["choices"][0]["delta"]["tool_calls"][0]
    assert tc["id"] == "call_1"
    assert tc["function"]["name"] == "read_file"


def test_block_close_dropped_on_openai_wire():
    frames = evf_payload_to_openai_frames(
        {"type": "block_close", "block_id": "b1", "block_kind": "tools", "seq": 2},
        completion_id="chatcmpl-test",
        tool_index_by_id={},
    )
    assert frames == []


def test_meta_side_channel_for_thread_state():
    frames = evf_payload_to_openai_frames(
        {"type": "thread_state", "title": "t", "todos": [], "artifacts": [], "anchored": True},
        completion_id="chatcmpl-test",
        tool_index_by_id={},
    )
    assert len(frames) == 1
    text = frames[0].decode("utf-8")
    assert text.startswith("event: meta\n")
    payload = json.loads(text.split("data:", 1)[1].strip())
    assert payload["type"] == "thread_state"


def test_openai_tool_call_args_emit_incremental_delta():
    accum: dict[str, str] = {}
    index: dict[str, int] = {}
    frames1 = evf_payload_to_openai_frames(
        {
            "type": "tool_call_chunk",
            "chunk": {
                "id": "call_1",
                "name": "read_file",
                "function": {"name": "read_file", "arguments": '{"path":'},
            },
        },
        completion_id="chatcmpl-test",
        tool_index_by_id=index,
        tool_args_accum=accum,
    )
    assert frames1
    p1 = decode_sse_payload(frames1[0])
    assert p1["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"] == '{"path":'

    frames2 = evf_payload_to_openai_frames(
        {
            "type": "tool_call_chunk",
            "chunk": {
                "id": "call_1",
                "function": {"arguments": '"a.ts"}'},
            },
        },
        completion_id="chatcmpl-test",
        tool_index_by_id=index,
        tool_args_accum=accum,
    )
    assert frames2
    p2 = decode_sse_payload(frames2[0])
    assert p2["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"] == '"a.ts"}'


def test_openai_normalizer_finish_emits_done():
    norm = OpenAiStreamNormalizer(user_input="hi", thread_id="thread-x")
    norm.feed_frame(
        "values",
        {
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "ok", "id": "m1"},
            ]
        },
    )
    chunks = norm.feed_frame(
        "messages",
        [{"type": "AIMessageChunk", "content": "!", "id": "m2"}],
    )
    assert any(b"chat.completion.chunk" in c for c in chunks)
    finish = norm.finish()
    assert any(b"[DONE]" in c for c in finish)
