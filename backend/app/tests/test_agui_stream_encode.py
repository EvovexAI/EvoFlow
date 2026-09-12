"""Golden tests: EVF → AG-UI event mapping."""

from __future__ import annotations

import pytest

from app.gateway.agui_stream_encode import decode_agui_payload
from app.gateway.agui_stream_normalizer import (
    AgUiEncoderState,
    AgUiStreamNormalizer,
    convert_evf_frames_to_agui,
    evf_payload_to_agui_events,
)
from app.gateway.sse_ui_normalize import UiStreamNormalizer, _encode_evf
from app.gateway.streaming.post_stream_ui_normalize import PostStreamUiTransform


def _decode_agui_from_frame(raw: bytes) -> dict:
    parsed = decode_agui_payload(raw)
    assert parsed is not None
    return parsed


def _event_types(frames: list[bytes]) -> list[str]:
    return [_decode_agui_from_frame(f)["type"] for f in frames]


def test_delta_emits_text_message_lifecycle():
    state = AgUiEncoderState(thread_id="t1", run_id="r1")
    events = evf_payload_to_agui_events(
        {
            "type": "delta",
            "text": "hello plan",
            "block_id": "t1:0:b1",
            "block_kind": "plan_text",
            "seq": 1,
        },
        state=state,
    )
    types = [e["type"] for e in events]
    assert types[0] == "RUN_STARTED"
    assert "STEP_STARTED" in types
    start = next(e for e in events if e["type"] == "TEXT_MESSAGE_START")
    assert start.get("blockId") == "t1:0:b1"
    assert start.get("blockKind") == "plan_text"
    assert start.get("seq") == 1
    content = next(e for e in events if e["type"] == "TEXT_MESSAGE_CONTENT")
    assert content.get("seq") == 1
    assert "TEXT_MESSAGE_START" in types
    assert "TEXT_MESSAGE_CONTENT" in types

    close_events = evf_payload_to_agui_events(
        {"type": "block_close", "block_id": "t1:0:b1", "block_kind": "plan_text", "seq": 1},
        state=state,
    )
    close_types = [e["type"] for e in close_events]
    assert "TEXT_MESSAGE_END" in close_types
    assert "STEP_FINISHED" in close_types


def test_reasoning_then_tool_then_body_golden():
    """思考 → 工具 → 正文 一轮完整事件序列."""
    norm = AgUiStreamNormalizer(user_input="demo", anchored=True, allow_tuple_tools=True, thread_id="thread-g")
    norm.inner.block_ledger.reset("thread-g:0")

    all_types: list[str] = []
    frames = norm.inner._emit_delta_raw("## plan", content_phase="pre_tools")
    all_types.extend(_event_types(convert_evf_frames_to_agui(frames, state=norm._state, ledger=norm.inner.block_ledger)))

    norm.inner.block_ledger.drain_closed()
    out_tools: list[bytes] = []
    norm.inner._append_write_tool_wire(
        out_tools,
        {
            "id": "call_read",
            "name": "read_file",
            "function": {"name": "read_file", "arguments": '{"path":"a.md"}'},
        },
        ev_type="tool_call",
        source="test",
    )
    all_types.extend(
        _event_types(convert_evf_frames_to_agui(out_tools, state=norm._state, ledger=norm.inner.block_ledger))
    )

    frames_reason = norm.inner._emit_delta_raw("", content_phase="pre_tools")
    _ = frames_reason
    reasoning_payload = {"type": "reasoning", "preview": "thinking hard", "block_id": "thread-g:0:b2", "block_kind": "reasoning"}
    norm.inner.block_ledger.reasoning_delta("thinking hard")
    all_types.extend(
        _event_types(
            convert_evf_frames_to_agui(
                [_encode_evf(reasoning_payload)],
                state=norm._state,
                ledger=norm.inner.block_ledger,
            )
        )
    )

    frames_body = norm.inner._emit_delta_raw("final answer", content_phase="post_tools")
    all_types.extend(_event_types(convert_evf_frames_to_agui(frames_body, state=norm._state, ledger=norm.inner.block_ledger)))

    finish = norm.finish()
    all_types.extend(_event_types(finish))

    assert "RUN_STARTED" in all_types
    assert "REASONING_START" in all_types
    assert "REASONING_MESSAGE_CONTENT" in all_types
    assert "TOOL_CALL_START" in all_types
    assert "TOOL_CALL_ARGS" in all_types
    assert "TEXT_MESSAGE_CONTENT" in all_types
    assert "RUN_FINISHED" in all_types
    assert all_types.count("RUN_STARTED") == 1


def test_tool_result_emits_end_and_result():
    state = AgUiEncoderState(thread_id="t2", run_id="r2")
    evf_payload_to_agui_events(
        {"type": "tool_call", "tool_calls": [{"id": "c1", "name": "grep", "function": {"name": "grep", "arguments": "{}"}}]},
        state=state,
    )
    events = evf_payload_to_agui_events(
        {"type": "tool_result", "tool_call_id": "c1", "content": "found 3 matches"},
        state=state,
    )
    types = [e["type"] for e in events]
    assert "TOOL_CALL_END" in types
    assert "TOOL_CALL_RESULT" in types


def test_tool_call_args_from_args_dict():
    state = AgUiEncoderState(thread_id="t3", run_id="r3")
    events = evf_payload_to_agui_events(
        {
            "type": "tool_call",
            "tool_calls": [
                {"id": "c-read", "name": "read", "args": {"path": "skill:evoflow-intro"}},
            ],
        },
        state=state,
    )
    types = [e["type"] for e in events]
    assert "TOOL_CALL_START" in types
    assert "TOOL_CALL_ARGS" in types
    args_evt = next(e for e in events if e["type"] == "TOOL_CALL_ARGS")
    assert "skill:evoflow-intro" in str(args_evt.get("delta") or "")


def test_thread_state_emits_tool_call_args_after_start_without_args():
    state = AgUiEncoderState(thread_id="t5", run_id="r5")
    evf_payload_to_agui_events(
        {"type": "tool_call", "tool_calls": [{"id": "c-read", "name": "read"}]},
        state=state,
    )
    events = evf_payload_to_agui_events(
        {
            "type": "thread_state",
            "toolCalls": [
                {"name": "read", "args": {"path": "skill:evoflow-intro"}, "id": "c-read"},
            ],
            "activityKind": "tools",
        },
        state=state,
    )
    types = [e["type"] for e in events]
    assert "TOOL_CALL_ARGS" in types
    args_evt = next(e for e in events if e["type"] == "TOOL_CALL_ARGS")
    assert "skill:evoflow-intro" in str(args_evt.get("delta") or "")


def test_custom_agent_activity_emits_tool_call_start_and_args():
    state = AgUiEncoderState(thread_id="t5b", run_id="r5b")
    events = evf_payload_to_agui_events(
        {
            "type": "custom",
            "chunk": {
                "type": "agent_activity",
                "kind": "tools",
                "tool_calls": [
                    {
                        "name": "scenario",
                        "args": {"action": "activate", "scenario_key": "workspace"},
                        "id": "c-scenario",
                    },
                ],
            },
        },
        state=state,
    )
    types = [e["type"] for e in events]
    assert types.count("TOOL_CALL_START") == 1
    assert "TOOL_CALL_ARGS" in types


def test_tool_result_does_not_reemit_tool_call_args():
    state = AgUiEncoderState(thread_id="t5c", run_id="r5c")
    evf_payload_to_agui_events(
        {
            "type": "tool_call",
            "tool_calls": [{"id": "c-find", "name": "find", "args": {"pattern": "*.md"}}],
        },
        state=state,
    )
    events = evf_payload_to_agui_events(
        {"type": "tool_result", "tool_call_id": "c-find", "content": "ok"},
        state=state,
    )
    assert sum(1 for e in events if e["type"] == "TOOL_CALL_ARGS") == 0


def test_snapshot_args_do_not_concatenate_streaming_partial():
    state = AgUiEncoderState(thread_id="t5d", run_id="r5d")
    evf_payload_to_agui_events(
        {"type": "tool_call", "tool_calls": [{"id": "c-write", "name": "write"}]},
        state=state,
    )
    evf_payload_to_agui_events(
        {
            "type": "tool_call_chunk",
            "chunk": {"id": "c-write", "name": "write", "args": {"path": "_tmp.txt"}},
        },
        state=state,
    )
    events = evf_payload_to_agui_events(
        {
            "type": "custom",
            "chunk": {
                "type": "agent_activity",
                "kind": "tools",
                "tool_calls": [
                    {
                        "name": "write",
                        "args": {"path": "_tmp.txt", "content": "hello\n"},
                        "id": "c-write",
                    },
                ],
            },
        },
        state=state,
    )
    arg_events = [e for e in events if e["type"] == "TOOL_CALL_ARGS"]
    assert len(arg_events) == 1
    delta = str(arg_events[0].get("delta") or "")
    # First chunk already streamed path; this snapshot must emit only the extension
    # (not concatenate a second full `{"path"...}` blob).
    assert delta.count('{"path"') == 0
    assert "hello" in delta
    accum = state.tool_args_accum["c-write"]
    assert accum.count('{"path"') == 1
    assert "hello" in accum


def test_write_tool_call_chunks_emit_args_every_growth():
    """Regression: write content streamed as growing JSON snapshots must emit
    TOOL_CALL_ARGS on *each* growth, not only the first path-only chunk."""
    state = AgUiEncoderState(thread_id="t5e", run_id="r5e")
    evf_payload_to_agui_events(
        {"type": "tool_call", "tool_calls": [{"id": "c-write2", "name": "write_to_file"}]},
        state=state,
    )
    first = evf_payload_to_agui_events(
        {
            "type": "tool_call_chunk",
            "chunk": {
                "id": "c-write2",
                "name": "write_to_file",
                "args": {"path": "out.md"},
            },
        },
        state=state,
    )
    second = evf_payload_to_agui_events(
        {
            "type": "tool_call_chunk",
            "chunk": {
                "id": "c-write2",
                "name": "write_to_file",
                "args": {"path": "out.md", "content": "你好"},
            },
        },
        state=state,
    )
    third = evf_payload_to_agui_events(
        {
            "type": "tool_call_chunk",
            "chunk": {
                "id": "c-write2",
                "name": "write_to_file",
                "args": {"path": "out.md", "content": "你好世界"},
            },
        },
        state=state,
    )
    first_args = [e for e in first if e["type"] == "TOOL_CALL_ARGS"]
    second_args = [e for e in second if e["type"] == "TOOL_CALL_ARGS"]
    third_args = [e for e in third if e["type"] == "TOOL_CALL_ARGS"]
    assert len(first_args) == 1
    assert "out.md" in str(first_args[0].get("delta") or "")
    assert len(second_args) == 1, "content growth must emit TOOL_CALL_ARGS (was dropped after first chunk)"
    assert "你好" in str(second_args[0].get("delta") or "")
    assert len(third_args) == 1
    assert "你好世界" in str(third_args[0].get("delta") or "")
    assert state.tool_args_accum["c-write2"].count("你好世界") == 1


def test_tool_result_preserves_truncated_meta():
    state = AgUiEncoderState(thread_id="t4", run_id="r4")
    evf_payload_to_agui_events(
        {"type": "tool_call", "tool_calls": [{"id": "c1", "name": "read", "args": {"path": "a.txt"}}]},
        state=state,
    )
    events = evf_payload_to_agui_events(
        {
            "type": "tool_result",
            "tool_call_id": "c1",
            "content": "",
            "truncated": True,
            "content_bytes": 8192,
            "status": "ok",
        },
        state=state,
    )
    result = next(e for e in events if e["type"] == "TOOL_CALL_RESULT")
    assert result.get("content") == ""
    assert result.get("truncated") is True
    assert result.get("content_bytes") == 8192


def test_tool_result_pending_approval_status_from_envelope():
    import json

    from app.gateway.sse_ui_normalize import _slim_tool_result_message

    pending_body = json.dumps(
        {
            "_evoflow_tool": {"status": "pending_approval"},
            "approval": {"tool_name": "delete", "tool_call_id": "c-del", "summary": "outputs/x"},
        },
        ensure_ascii=False,
    )
    slim = _slim_tool_result_message(
        {
            "type": "tool",
            "tool_call_id": "c-del",
            "name": "delete",
            "content": pending_body,
        }
    )
    assert slim["status"] == "pending_approval"


def test_tool_result_pending_approval_propagates_to_agui():
    import json

    state = AgUiEncoderState(thread_id="t-del", run_id="r-del")
    evf_payload_to_agui_events(
        {
            "type": "tool_call",
            "tool_calls": [{"id": "c-del", "name": "delete", "args": {"path": "outputs/x"}}],
        },
        state=state,
    )
    pending_body = json.dumps(
        {
            "_evoflow_tool": {"status": "pending_approval"},
            "approval": {"tool_name": "delete", "tool_call_id": "c-del", "summary": "outputs/x"},
        },
        ensure_ascii=False,
    )
    events = evf_payload_to_agui_events(
        {
            "type": "tool_result",
            "tool_call_id": "c-del",
            "content": pending_body,
            "status": "pending_approval",
        },
        state=state,
    )
    result = next(e for e in events if e["type"] == "TOOL_CALL_RESULT")
    assert result.get("status") == "pending_approval"
    assert "pending_approval" in str(result.get("content") or "")


def test_custom_tool_approval_pending_emits_tool_result_evf():
    norm = UiStreamNormalizer(user_input="delete demo", anchored=True, allow_tuple_tools=True)
    evf = norm.feed_evf_payloads(
        "custom",
        {
            "type": "tool_approval_pending",
            "tool_call_id": "c-del",
            "tool_name": "delete",
            "content": '{"_evoflow_tool":{"status":"pending_approval"}}',
        },
    )
    types = [p["type"] for p in evf]
    assert "custom" in types
    assert "tool_result" in types
    tr = next(p for p in evf if p["type"] == "tool_result")
    assert tr["tool_call_id"] == "c-del"
    assert tr["status"] == "pending_approval"
    assert "c-del" in norm.emitted_tool_call_ids
    act = next(p for p in evf if p["type"] == "activity")
    assert act["kind"] == "tool_approval"


def test_custom_tool_approval_pending_propagates_to_agui():
    norm = UiStreamNormalizer(user_input="delete demo", anchored=True, allow_tuple_tools=True)
    state = AgUiEncoderState(thread_id="t-del2", run_id="r-del2")
    evf_payload_to_agui_events(
        {
            "type": "tool_call",
            "tool_calls": [{"id": "c-del", "name": "delete", "args": {"path": "outputs/x"}}],
        },
        state=state,
    )
    evf = norm.feed_evf_payloads(
        "custom",
        {
            "type": "tool_approval_pending",
            "tool_call_id": "c-del",
            "tool_name": "delete",
            "content": '{"_evoflow_tool":{"status":"pending_approval"}}',
        },
    )
    frames = convert_evf_frames_to_agui([_encode_evf(p) for p in evf], state=state, ledger=norm.block_ledger)
    types = _event_types(frames)
    assert "TOOL_CALL_RESULT" in types
    result = _decode_agui_from_frame(next(f for f in frames if b"TOOL_CALL_RESULT" in f))
    assert result.get("status") == "pending_approval"


def test_tool_call_start_carries_block_meta():
    state = AgUiEncoderState(thread_id="t1", run_id="r1")
    events = evf_payload_to_agui_events(
        {
            "type": "tool_call",
            "block_id": "t1:0:b2",
            "block_kind": "tools",
            "seq": 2,
            "tool_calls": [{"id": "c1", "name": "grep", "function": {"name": "grep", "arguments": "{}"}}],
        },
        state=state,
    )
    start = next(e for e in events if e["type"] == "TOOL_CALL_START")
    assert start.get("blockId") == "t1:0:b2"
    assert start.get("blockKind") == "tools"
    assert start.get("seq") == 2


def test_run_end_snapshot_includes_tool_args_from_thread_state():
    norm = UiStreamNormalizer(user_input="demo", anchored=True, thread_id="thread-ts")
    norm.block_ledger.reset("thread-ts:0")
    state = AgUiEncoderState(thread_id="thread-ts", run_id="r-ts")
    evf_payload_to_agui_events(
        {"type": "tool_call", "tool_calls": [{"id": "c-read", "name": "read"}]},
        state=state,
    )
    meta = norm.block_ledger.before_tools()
    norm.block_ledger.register_tool_id(meta.block_id, "c-read")
    evf_payload_to_agui_events(
        {
            "type": "thread_state",
            "toolCalls": [{"name": "read", "args": {"path": "a.md"}, "id": "c-read"}],
            "activityKind": "tools",
        },
        state=state,
    )
    frames = norm._build_run_end_frames()
    agui_frames = convert_evf_frames_to_agui(frames, state=state, ledger=norm.block_ledger)
    snap_frame = next(
        _decode_agui_from_frame(f) for f in agui_frames if _decode_agui_from_frame(f)["type"] == "MESSAGES_SNAPSHOT"
    )
    messages = snap_frame.get("messages") or []
    tool_msg = next(m for m in messages if m.get("toolCalls"))
    args = tool_msg["toolCalls"][0]["function"]["arguments"]
    assert "a.md" in str(args)


def test_run_end_snapshot_includes_block_seq():
    norm = UiStreamNormalizer(user_input="demo", anchored=True, thread_id="thread-seq")
    norm.block_ledger.reset("thread-seq:0")
    norm.block_ledger.delta_text("plan", "pre_tools")
    norm.block_ledger.reasoning_delta("think")
    state = AgUiEncoderState(thread_id="thread-seq", run_id="r-seq")
    frames = norm._build_run_end_frames()
    agui_frames = convert_evf_frames_to_agui(frames, state=state, ledger=norm.block_ledger)
    snap_frame = next(
        _decode_agui_from_frame(f) for f in agui_frames if _decode_agui_from_frame(f)["type"] == "MESSAGES_SNAPSHOT"
    )
    messages = snap_frame.get("messages") or []
    for msg in messages:
        assert msg.get("seq"), f"missing seq on snapshot message: {msg}"
        assert msg.get("blockKind"), f"missing blockKind on snapshot message: {msg}"


def test_subagent_task_running_does_not_emit_nested_tool_call():
    state = AgUiEncoderState(thread_id="t6", run_id="r6")
    evf_payload_to_agui_events(
        {
            "type": "custom",
            "chunk": {
                "type": "task_running",
                "task_id": "call_sub",
                "message": {
                    "content": "subagent internal",
                    "tool_calls": [{"name": "terminal", "args": {"command": "echo hi"}, "id": "call_nested"}],
                },
            },
        },
        state=state,
    )
    events = evf_payload_to_agui_events(
        {"type": "tool_call", "tool_calls": [{"id": "call_nested", "name": "terminal", "args": {"command": "echo hi"}}]},
        state=state,
    )
    types = [e["type"] for e in events]
    assert "TOOL_CALL_START" not in types
    assert "call_nested" in state.subagent_nested_tool_call_ids


def test_subagent_task_running_blocks_leaked_delta():
    state = AgUiEncoderState(thread_id="t6b", run_id="r6b")
    evf_payload_to_agui_events(
        {
            "type": "custom",
            "chunk": {"type": "task_running", "task_id": "call_sub", "message": {"content": "leaked body"}},
        },
        state=state,
    )
    events = evf_payload_to_agui_events({"type": "delta", "text": "leaked body", "block_kind": "body_text"}, state=state)
    assert not any(e["type"] == "TEXT_MESSAGE_CONTENT" for e in events)


def test_run_end_includes_messages_snapshot():
    norm = UiStreamNormalizer(user_input="demo", anchored=True, thread_id="thread-h")
    norm.block_ledger.reset("thread-h:0")
    norm.block_ledger.delta_text("body text", "post_tools")
    state = AgUiEncoderState(thread_id="thread-h", run_id="r-h")
    evf_payload_to_agui_events({"type": "delta", "text": "body text", "block_id": "thread-h:0:b1", "block_kind": "body_text"}, state=state)
    frames = norm._build_run_end_frames()
    agui_frames = convert_evf_frames_to_agui(frames, state=state, ledger=norm.block_ledger)
    types = _event_types(agui_frames)
    assert "RUN_FINISHED" in types
    assert "MESSAGES_SNAPSHOT" in types
    snap_frame = next(_decode_agui_from_frame(f) for f in agui_frames if _decode_agui_from_frame(f)["type"] == "MESSAGES_SNAPSHOT")
    messages = snap_frame.get("messages")
    assert isinstance(messages, list)
    assert any(m.get("role") == "assistant" for m in messages)


def test_agui_set_run_id_before_run_started():
    """LangGraph metadata run id must replace gateway run-{hex} placeholder."""
    lg_rid = "019ef073-b7df-7263-9b80-e47afcaf1b38"
    norm = AgUiStreamNormalizer(user_input="hi", thread_id="t1")
    assert norm._state.run_id.startswith("run-")
    norm.set_run_id(lg_rid)
    norm.inner.block_ledger.reset("t1:0")
    frames = norm.inner._emit_delta_raw("hello")
    agui = convert_evf_frames_to_agui(frames, state=norm._state, ledger=norm.inner.block_ledger)
    started = _decode_agui_from_frame(agui[0])
    assert started["type"] == "RUN_STARTED"
    assert started["runId"] == lg_rid


def test_post_stream_metadata_syncs_agui_encoder_run_id(monkeypatch: pytest.MonkeyPatch):
    """POST stream: metadata frame updates AgUiEncoderState before RUN_STARTED."""
    patched: list[str] = []

    def fake_patch(*, thread_id: str | None = None, run_id: str = "", **kwargs):  # noqa: ANN003
        patched.append(str(run_id))
        return True

    monkeypatch.setattr(
        "evoflow.session_execution.lifecycle.patch_session_current_run_id",
        fake_patch,
    )
    lg_rid = "019ef073-b7df-7263-9b80-e47afcaf1b38"
    transform = PostStreamUiTransform(
        thread_id="tid-meta",
        body=b"",
        stream_format="agui",
        run_id=None,
        mirror_enabled=False,
    )
    norm = transform.normalizer
    assert isinstance(norm, AgUiStreamNormalizer)
    assert norm._state.run_id.startswith("run-")

    transform.feed_upstream_for_mirror(
        f'event: metadata\ndata: {{"run_id":"{lg_rid}"}}\n\n'.encode()
    )
    assert transform.run_id == lg_rid
    assert norm._state.run_id == lg_rid
    assert patched == [lg_rid]


def test_agui_sse_frame_format():
    from app.gateway.agui_stream_encode import encode_agui_event

    raw = encode_agui_event({"type": "RUN_STARTED", "threadId": "t", "runId": "r"})
    text = raw.decode("utf-8")
    assert text.startswith("event: ag-ui\n")
    assert "RUN_STARTED" in text
