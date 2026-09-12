"""Write-file live progress: content_delta on args phase, no body_text leak."""

from __future__ import annotations

from app.gateway.agui_stream_normalizer import AgUiEncoderState, evf_payload_to_agui_events
from app.gateway.sse_ui_normalize import UiStreamNormalizer


def test_write_sanitize_emits_content_delta_not_body_args():
    norm = UiStreamNormalizer(
        user_input="write a file",
        anchored=True,
        allow_tuple_tools=True,
        thread_id="t1",
    )
    out: list = []
    chunks = [
        {
            "id": "w1",
            "name": "write_to_file",
            "function": {"name": "write_to_file", "arguments": '{"path":"out.md"}'},
        },
        {
            "id": "w1",
            "name": "write_to_file",
            "function": {
                "name": "write_to_file",
                "arguments": '{"path":"out.md","content":"你"}',
            },
        },
        {
            "id": "w1",
            "name": "write_to_file",
            "function": {
                "name": "write_to_file",
                "arguments": '{"path":"out.md","content":"你好世界"}',
            },
        },
    ]
    for ch in chunks:
        meta = norm.block_ledger.before_tools()
        norm._append_write_tool_wire(
            out, ch, ev_type="tool_call_chunk", source="test", chunk_meta=ch, meta=meta
        )

    progress = [p for p in out if p.get("type") == "write_file_progress"]
    assert progress, "expected write_file_progress events"
    deltas = "".join(str(p.get("content_delta") or "") for p in progress)
    assert "你好世界" == deltas or deltas.endswith("好世界") or "你" in deltas
    # Wire args stay path-only (no full content flood).
    for p in out:
        if p.get("type") != "tool_call_chunk":
            continue
        args = str((p.get("chunk") or {}).get("function", {}).get("arguments") or "")
        assert "content" not in args

    state = AgUiEncoderState(thread_id="t1", run_id="r1")
    custom_contents: list[str] = []
    for p in out:
        events = evf_payload_to_agui_events(p, state=state)
        for e in events:
            if e.get("type") == "CUSTOM" and e.get("name") == "write_file_progress":
                v = e.get("value") or {}
                if v.get("content_delta"):
                    custom_contents.append(str(v["content_delta"]))
                if v.get("content"):
                    custom_contents.append(str(v["content"]))
    joined = "".join(custom_contents)
    assert "你" in joined
    assert "好世界" in joined or "你好世界" in joined


def test_write_tool_content_not_emitted_as_body_text():
    norm = UiStreamNormalizer(
        user_input="write",
        anchored=True,
        allow_tuple_tools=True,
        thread_id="t2",
    )
    frame = [
        {
            "type": "AIMessageChunk",
            "id": "ai-1",
            "content": "**古镇** — 江南水乡",
            "tool_call_chunks": [
                {
                    "index": 0,
                    "id": "w2",
                    "name": "write_to_file",
                    "function": {
                        "name": "write_to_file",
                        "arguments": '{"path":"a.md","content":"x"}',
                    },
                    "args": '{"path":"a.md","content":"x"}',
                }
            ],
            "additional_kwargs": {},
        },
        {"langgraph_node": "agent"},
    ]
    wire = b"".join(norm.feed_frame("messages", frame)).decode("utf-8", errors="ignore")
    assert "**古镇**" not in wire
    assert "江南水乡" not in wire


def test_empty_tool_calls_list_does_not_fragment_post_tool_reply():
    """Regression: LangGraph sends tool_calls=[] on text chunks; must not before_tools()."""
    norm = UiStreamNormalizer(
        user_input="再来一次",
        anchored=True,
        allow_tuple_tools=True,
        thread_id="bf3e4b97-2563-4298-b66b-f1e461e16f03",
    )
    norm.block_ledger.reset("bf3e4b97-2563-4298-b66b-f1e461e16f03:0")
    # Simulate prior write tool so allow_tuple_tools stays on.
    meta = norm.block_ledger.before_tools()
    norm.block_ledger.register_tool_id(meta.block_id, "call_write")
    norm.allow_tuple_tools = True
    norm.tuple_tools_kicked = True

    pieces = ["搞定", "！新文件写在", "@@outputs/味蕾", "记忆", ".md@@"]
    for piece in pieces:
        frame = [
            {
                "type": "AIMessageChunk",
                "id": "ai-reply-1",
                "content": piece,
                "tool_calls": [],  # the trap
                "additional_kwargs": {},
            },
            {"langgraph_node": "agent"},
        ]
        norm.feed_frame("messages", frame)

    segs = norm.block_ledger.export_display_segments()
    body = [s for s in segs if s.get("block_kind") == "body_text" or s.get("kind") == "text"]
    empty_tools = [
        s
        for s in segs
        if (s.get("block_kind") == "tools" or s.get("kind") == "tools") and not (s.get("ids") or [])
    ]
    assert len(body) == 1, f"expected one continuous body_text, got {len(body)}: {body}"
    joined = "".join(str(s.get("text") or "") for s in body)
    assert joined == "".join(pieces)
    assert len(empty_tools) == 0, f"empty tools fragments: {empty_tools}"
