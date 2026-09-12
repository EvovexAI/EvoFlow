"""Tests for channel manager stream text extraction."""

from app.channels.manager import (
    _accumulate_evf_stream_text,
    _accumulate_stream_text,
    _channel_stream_params,
    _extract_custom_stream_text,
    _is_im_live_assistant_stream_row,
    _merge_stream_text,
)


def test_channel_stream_params_disables_ui_sse_for_gateway_proxy():
    assert _channel_stream_params("http://127.0.0.1:8070/api/langgraph") == {"ui_sse": "0"}
    assert _channel_stream_params("http://localhost:2024") is None


def test_accumulate_evf_stream_text_delta_append():
    state: dict[str, str] = {}
    assert _accumulate_evf_stream_text(state, {"type": "delta", "text": "hel"}) == "hel"
    assert _accumulate_evf_stream_text(state, {"type": "delta", "text": "hello"}) == "hello"


def test_accumulate_evf_stream_text_run_end():
    state: dict[str, str] = {"text": "partial"}
    assert _accumulate_evf_stream_text(state, {"type": "run_end", "text": "final answer"}) == "final answer"


def test_accumulate_evf_stream_text_delta_replace():
    state: dict[str, str] = {"text": "old"}
    assert _accumulate_evf_stream_text(
        state,
        {"type": "delta", "text": "new", "delta_kind": "replace"},
    ) == "new"


def test_is_im_live_assistant_accepts_chunks_only():
    assert _is_im_live_assistant_stream_row({"type": "AIMessageChunk", "content": "hi"})
    assert not _is_im_live_assistant_stream_row({"type": "AIMessage", "content": "hi"})
    assert not _is_im_live_assistant_stream_row({"type": "ai", "content": "hi"})
    assert not _is_im_live_assistant_stream_row({"type": "human", "content": "user ask"})
    assert not _is_im_live_assistant_stream_row({"type": "HumanMessage", "content": "user ask"})
    assert not _is_im_live_assistant_stream_row({"type": "HumanMessageChunk", "content": "user ask"})
    assert not _is_im_live_assistant_stream_row({"type": "tool", "content": "ok"})
    assert not _is_im_live_assistant_stream_row({"role": "user", "content": "hi"})


def test_accumulate_stream_text_skips_human_and_history():
    buffers: dict[str, str] = {}
    mid = None

    text, mid = _accumulate_stream_text(
        buffers,
        mid,
        [{"type": "human", "content": "帮我写周报", "id": "h1"}, {}],
    )
    assert text is None
    assert buffers == {}

    text, mid = _accumulate_stream_text(
        buffers,
        mid,
        [{"type": "AIMessage", "content": "上一轮完整回复", "id": "old-ai"}, {}],
    )
    assert text is None
    assert buffers == {}

    text, mid = _accumulate_stream_text(
        buffers,
        mid,
        [{"type": "AIMessageChunk", "content": "本", "id": "ai-1"}, {}],
    )
    assert text == "本"
    assert mid == "ai-1"

    text, mid = _accumulate_stream_text(
        buffers,
        mid,
        [{"type": "AIMessageChunk", "content": "本周", "id": "ai-1"}, {}],
    )
    assert text == "本周"


def test_accumulate_stream_text_new_message_id_starts_fresh():
    buffers: dict[str, str] = {}
    text, mid = _accumulate_stream_text(
        buffers,
        None,
        [{"type": "AIMessageChunk", "content": "第一轮", "id": "a"}, {}],
    )
    assert text == "第一轮"
    text, mid = _accumulate_stream_text(
        buffers,
        mid,
        [{"type": "AIMessageChunk", "content": "第二轮开头", "id": "b"}, {}],
    )
    assert text == "第二轮开头"
    assert mid == "b"
    assert buffers["a"] == "第一轮"
    assert buffers["b"] == "第二轮开头"


def test_accumulate_stream_text_bare_string_only_continues_open_buffer():
    buffers: dict[str, str] = {}
    assert _accumulate_stream_text(buffers, None, "orphan") == (None, None)

    buffers["ai-1"] = "Hel"
    text, mid = _accumulate_stream_text(buffers, "ai-1", "lo")
    assert text == "Hello"
    assert mid == "ai-1"


def test_extract_custom_stream_text_skips_progress_content():
    assert _extract_custom_stream_text({"type": "delta", "text": "ok"}) == "ok"
    assert _extract_custom_stream_text({"type": "token_delta", "chunk": "x"}) == "x"
    assert (
        _extract_custom_stream_text(
            {"type": "write_file_progress", "content": "huge file body " * 20}
        )
        == ""
    )
    assert _extract_custom_stream_text({"type": "tool_status", "content": "running"}) == ""
    # Untyped content still allowed for adapters that only send content
    assert _extract_custom_stream_text({"content": "plain"}) == "plain"


def test_merge_stream_text_cumulative_and_delta():
    assert _merge_stream_text("Hel", "Hello") == "Hello"
    assert _merge_stream_text("Hello", "lo") == "Hello"
    assert _merge_stream_text("Hel", "lo") == "Hello"
