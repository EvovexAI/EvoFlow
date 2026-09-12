"""SSE normalize attaches block_id/seq to delta/reasoning/tool events."""

from __future__ import annotations

import json

from app.gateway.sse_ui_normalize import UiStreamNormalizer


def _decode_evf_payload(raw: bytes | dict) -> dict:
    if isinstance(raw, dict):
        return raw
    text = raw.decode("utf-8")
    for line in text.splitlines():
        if line.startswith("data:"):
            return json.loads(line[5:].strip())
    raise AssertionError(f"no data line in {text!r}")


def test_emit_delta_raw_includes_block_wire():
    norm = UiStreamNormalizer(user_input="hello", anchored=True, thread_id="thread-a")
    norm.block_ledger.reset("thread-a:0")
    frames = norm._emit_delta_raw("hello plan", content_phase="pre_tools")
    assert frames
    payload = _decode_evf_payload(frames[0])
    assert payload["type"] == "delta"
    assert payload["block_id"] == "thread-a:0:b1"
    assert payload["block_kind"] == "plan_text"
    assert payload["seq"] == 1


def test_emit_delta_raw_keeps_consecutive_identical_tokens():
    """Regression: doubled digits like 4455… must not lose the second identical token."""
    norm = UiStreamNormalizer(user_input="digits", anchored=True, thread_id="thread-dup")
    norm.block_ledger.reset("thread-dup:0")
    pieces = ["4", "4", "55", "66", "7788", "99"]
    for piece in pieces:
        assert norm._emit_delta_raw(piece, content_phase="pre_tools")
    assert norm.per_message_stream_text.get("__noid__") == "445566778899"
    segs = norm.block_ledger.export_display_segments()
    text_segs = [s for s in segs if s.get("kind") == "text"]
    assert text_segs
    assert text_segs[0].get("text") == "445566778899"


def test_emit_delta_raw_append_is_passthrough_concat():
    """Append must not guess cumulative snapshots — only concatenate emitted pieces."""
    norm = UiStreamNormalizer(user_input="digits", anchored=True, thread_id="thread-pass")
    norm.block_ledger.reset("thread-pass:0")
    for piece in ["4", "4", "55"]:
        frames = norm._emit_delta_raw(piece, content_phase="pre_tools")
        assert _decode_evf_payload(frames[0])["text"] == piece
    assert norm.per_message_stream_text.get("__noid__") == "4455"


def test_tool_call_wire_includes_block_meta():
    norm = UiStreamNormalizer(user_input="demo", anchored=True, allow_tuple_tools=True, thread_id="thread-b")
    norm.block_ledger.reset("thread-b:0")
    out: list[bytes] = []
    norm._append_write_tool_wire(
        out,
        {
            "id": "call_1",
            "name": "read_file",
            "function": {"name": "read_file", "arguments": "{}"},
        },
        ev_type="tool_call",
        source="test",
    )
    assert out
    payload = _decode_evf_payload(out[0])
    assert payload["type"] == "tool_call"
    assert payload["block_kind"] == "tools"
    assert payload["seq"] == 1


def test_run_end_includes_display_segments_from_block_ledger():
    norm = UiStreamNormalizer(user_input="demo", anchored=True, thread_id="thread-c")
    norm.block_ledger.reset("thread-c:0")
    norm.block_ledger.delta_text("## plan", "pre_tools")
    norm.block_ledger.before_tools()
    norm.block_ledger.reasoning_delta("thinking")
    norm.block_ledger.delta_text("## report", "post_tools")
    frames = norm._build_run_end_frames()
    assert frames
    payload = _decode_evf_payload(frames[0])
    assert payload["type"] == "run_end"
    segs = payload.get("display_segments")
    assert isinstance(segs, list)
    assert len(segs) == 4
    assert [s["seq"] for s in segs] == [1, 2, 3, 4]
    assert payload.get("reasoning_preview") == "thinking"


def test_run_end_force_marks_session_terminal(monkeypatch) -> None:
    """Model ``event:end`` path must synchronously mark DB terminal (no LangGraph probe)."""
    forced: list[str] = []

    def fake_force_end(*, thread_id: str | None = None, **kwargs):  # noqa: ANN003
        forced.append(str(thread_id or ""))
        return True

    monkeypatch.setattr(
        "evoflow.session_execution.force_end_session_turn",
        fake_force_end,
    )
    norm = UiStreamNormalizer(user_input="demo", anchored=True, thread_id="thread-end")
    norm._build_run_end_frames()
    assert forced == ["thread-end"]


def test_run_end_text_follows_display_segment_seq() -> None:
    """run_end.text must follow block ledger seq (plan before body), not values merge order."""
    norm = UiStreamNormalizer(user_input="demo", anchored=True, thread_id="thread-order")
    norm.block_ledger.reset("thread-order:0")
    norm.block_ledger.delta_text("## plan first", "pre_tools")
    norm.block_ledger.before_tools()
    norm.block_ledger.delta_text("## report last", "post_tools")
    frames = norm._build_run_end_frames()
    assert frames
    payload = _decode_evf_payload(frames[0])
    text = str(payload.get("text") or "")
    assert "plan first" in text
    assert "report last" in text
    assert text.index("plan first") < text.index("report last")


def test_tool_call_emits_block_close_for_prior_plan():
    norm = UiStreamNormalizer(user_input="demo", anchored=True, allow_tuple_tools=True, thread_id="thread-d")
    norm.block_ledger.reset("thread-d:0")
    norm._emit_delta_raw("plan", content_phase="pre_tools")
    norm.block_ledger.drain_closed()
    out: list[bytes] = []
    norm._append_write_tool_wire(
        out,
        {
            "id": "call_1",
            "name": "read_file",
            "function": {"name": "read_file", "arguments": "{}"},
        },
        ev_type="tool_call",
        source="test",
    )
    types = [_decode_evf_payload(f)["type"] for f in out]
    assert "block_close" in types
    close_payload = next(_decode_evf_payload(f) for f in out if _decode_evf_payload(f)["type"] == "block_close")
    assert close_payload["block_kind"] == "plan_text"
    assert close_payload["seq"] == 1


def test_hidden_tool_call_not_emitted_to_chat_panel():
    norm = UiStreamNormalizer(user_input="demo", anchored=True, allow_tuple_tools=True, thread_id="thread-e")
    norm.block_ledger.reset("thread-e:0")
    out: list[bytes] = []
    norm._append_write_tool_wire(
        out,
        {
            "id": "call_sc",
            "name": "scenario",
            "function": {"name": "scenario", "arguments": "{}"},
        },
        ev_type="tool_call",
        source="test",
    )
    assert out == []
    segs = norm.block_ledger.snapshot_display_segments()
    assert not any(s.get("kind") == "tools" for s in segs)


def test_write_and_scenario_only_write_in_display_segments():
    norm = UiStreamNormalizer(user_input="demo", anchored=True, allow_tuple_tools=True, thread_id="thread-f")
    norm.block_ledger.reset("thread-f:0")
    norm.block_ledger.reasoning_delta("plan write")
    out: list[bytes] = []
    norm._append_write_tool_wire(
        out,
        {
            "id": "call_write",
            "name": "write",
            "function": {"name": "write", "arguments": '{"path":"demo.md"}'},
        },
        ev_type="tool_call",
        source="test",
    )
    norm._append_write_tool_wire(
        out,
        {
            "id": "call_sc",
            "name": "scenario",
            "function": {"name": "scenario", "arguments": "{}"},
        },
        ev_type="tool_call",
        source="test",
    )
    tool_payloads = [_decode_evf_payload(f) for f in out if _decode_evf_payload(f)["type"] == "tool_call"]
    assert len(tool_payloads) == 1
    assert tool_payloads[0]["tool_calls"][0]["id"] == "call_write"
    tool_segs = [s for s in norm.block_ledger.snapshot_display_segments() if s.get("kind") == "tools"]
    assert len(tool_segs) == 1
    assert tool_segs[0]["ids"] == ["call_write"]


def test_preanchor_skips_hydrated_complete_messages_before_anchor():
    """Transcript hydration replays complete AIMessages; must not re-emit as live SSE."""
    norm = UiStreamNormalizer(user_input="new turn", thread_id="thread-hydrate")
    hist_ai = {
        "type": "AIMessage",
        "role": "assistant",
        "id": "hist-assistant-1",
        "content": "好的，我想问您一个问题：历史轮次正文",
    }
    norm.feed_frame("messages", hist_ai)
    assert not norm.pre_anchor_stream_events

    chunk_ai = {
        "type": "AIMessageChunk",
        "role": "assistant",
        "id": "live-chunk-1",
        "content": "live ",
    }
    norm.feed_frame("messages", chunk_ai)
    assert len(norm.pre_anchor_stream_events) == 1

    values = {
        "messages": [
            {"type": "HumanMessage", "role": "user", "content": "old"},
            hist_ai,
            {"type": "HumanMessage", "role": "user", "content": "new turn"},
        ]
    }
    frames = norm.feed_frame("values", values)
    delta_texts = [_decode_evf_payload(f).get("text", "") for f in frames if _decode_evf_payload(f).get("type") == "delta"]
    assert not any("历史轮次" in t for t in delta_texts)
    assert any(t == "live " for t in delta_texts)


def test_anchored_skips_hydrated_complete_messages_on_messages_stream():
    """After anchor, transcript hydration must not replay historical rows as live SSE."""
    norm = UiStreamNormalizer(user_input="new turn", thread_id="thread-post-anchor")
    hist_ai = {
        "type": "AIMessage",
        "role": "assistant",
        "id": "hist-assistant-1",
        "content": "第一轮历史正文不应重放",
    }
    norm.feed_frame(
        "values",
        {
            "messages": [
                {"type": "HumanMessage", "role": "user", "content": "old"},
                hist_ai,
                {"type": "HumanMessage", "role": "user", "content": "new turn"},
            ]
        },
    )
    assert norm.anchored

    frames = norm.feed_frame("messages", hist_ai)
    delta_texts = [_decode_evf_payload(f).get("text", "") for f in frames if _decode_evf_payload(f).get("type") == "delta"]
    assert not delta_texts

    live_chunk = {
        "type": "AIMessageChunk",
        "role": "assistant",
        "id": "live-chunk-2",
        "content": "本轮新内容",
    }
    frames2 = norm.feed_frame("messages", live_chunk)
    delta_texts2 = [_decode_evf_payload(f).get("text", "") for f in frames2 if _decode_evf_payload(f).get("type") == "delta"]
    assert delta_texts2 == ["本轮新内容"]


def test_attach_stream_anchors_without_post_user_input():
    """GET join attach has no POST body; anchor on last human when user_input is empty."""
    norm = UiStreamNormalizer(user_input="", thread_id="thread-attach")
    norm.feed_frame(
        "values",
        {
            "messages": [
                {"type": "HumanMessage", "role": "user", "content": "请介绍 EvoFlow"},
            ]
        },
    )
    assert norm.anchored

    frames = norm.feed_frame(
        "messages",
        {
            "type": "AIMessageChunk",
            "role": "assistant",
            "id": "live-chunk-attach",
            "content": "EvoFlow 是…",
        },
    )
    delta_texts = [
        _decode_evf_payload(f).get("text", "")
        for f in frames
        if _decode_evf_payload(f).get("type") == "delta"
    ]
    assert delta_texts == ["EvoFlow 是…"]


def test_preanchor_replay_stripped_with_prior_turn_isolation():
    """Checkpoint echo before values anchor must not replay prior turn body/reasoning."""
    prior_body = "收到 👍"
    prior_reason = 'The user just sent "1".'
    norm = UiStreamNormalizer(
        user_input="哈哈哈",
        thread_id="thread-isolate",
        client_prior_prefix=prior_body,
        client_prior_reasoning=prior_reason,
    )
    norm.feed_frame(
        "messages",
        {
            "type": "AIMessageChunk",
            "role": "assistant",
            "id": "live-chunk-1",
            "content": f"{prior_body}哈哈 😄",
            "additional_kwargs": {"reasoning_content": f"{prior_reason}The user just said haha"},
        },
    )
    assert len(norm.pre_anchor_stream_events) == 1

    frames = norm.feed_frame(
        "values",
        {
            "messages": [
                {"type": "HumanMessage", "role": "user", "content": "1"},
                {
                    "type": "AIMessage",
                    "role": "assistant",
                    "content": prior_body,
                    "additional_kwargs": {"reasoning_content": prior_reason},
                },
                {"type": "HumanMessage", "role": "user", "content": "哈哈哈"},
            ]
        },
    )
    delta_texts = [
        _decode_evf_payload(f).get("text", "")
        for f in frames
        if _decode_evf_payload(f).get("type") == "delta"
    ]
    reasoning = [
        _decode_evf_payload(f).get("preview", "")
        for f in frames
        if _decode_evf_payload(f).get("type") == "reasoning"
    ]
    assert not any(prior_body in t for t in delta_texts)
    assert any("哈哈" in t for t in delta_texts)

    frames2 = norm.feed_frame(
        "messages",
        {
            "type": "AIMessageChunk",
            "role": "assistant",
            "id": "live-chunk-2",
            "content": "哈哈 😄",
            "additional_kwargs": {"reasoning_content": f"{prior_reason}The user just said haha"},
        },
    )
    reasoning = [
        _decode_evf_payload(f).get("preview", "")
        for f in frames2
        if _decode_evf_payload(f).get("type") == "reasoning"
    ]
    assert not any(prior_reason in r for r in reasoning)
    assert any("haha" in r.lower() for r in reasoning)
