"""High-fidelity gateway path: messages-tuple chunks → AgUiStreamNormalizer → ag-ui SSE.

Simulates vendor incremental function.arguments fragments exactly as LangGraph
would deliver them on the HTTP stream path (not the sanitize helper alone).
"""

from __future__ import annotations

import json
import time

from app.gateway.agui_stream_normalizer import AgUiStreamNormalizer


def _parse_agui_frames(blobs: list[bytes]) -> list[dict]:
    out: list[dict] = []
    buf = b"".join(blobs).decode("utf-8", errors="replace")
    for frame in buf.split("\n\n"):
        if not frame.strip():
            continue
        data_lines = [ln[5:].strip() for ln in frame.split("\n") if ln.startswith("data:")]
        if not data_lines:
            continue
        raw = "\n".join(data_lines)
        if raw in ("{}", "[DONE]"):
            continue
        try:
            out.append(json.loads(raw))
        except json.JSONDecodeError:
            continue
    return out


def test_agui_normalizer_streams_write_content_deltas_tokenwise():
    norm = AgUiStreamNormalizer(
        user_input="write a file",
        anchored=True,
        allow_tuple_tools=True,
        thread_id="verify-agui-path",
    )
    fragments = [
        '{"path":"outputs/_agui_path.md","content":"',
        "# 标题\\n\\n",
        "段落一内容。",
        "段落二继续。",
        "段落三收尾。",
        '"}',
    ]
    deltas: list[tuple[float, str]] = []
    t0 = time.perf_counter()
    for i, frag in enumerate(fragments):
        frame = [
            {
                "type": "AIMessageChunk",
                "id": "ai-write-stream",
                "content": "",
                "tool_call_chunks": [
                    {
                        "index": 0,
                        "id": "call_agui_write",
                        "name": "write" if i == 0 else None,
                        "function": {
                            "name": "write" if i == 0 else None,
                            "arguments": frag,
                        },
                        "args": frag,
                    }
                ],
                "additional_kwargs": {},
            },
            {"langgraph_node": "agent"},
        ]
        events = _parse_agui_frames(norm.feed_frame("messages", frame))
        for e in events:
            if e.get("type") == "CUSTOM" and e.get("name") == "write_file_progress":
                v = e.get("value") or {}
                piece = v.get("content_delta") or v.get("content") or ""
                if piece:
                    deltas.append((time.perf_counter() - t0, str(piece)))
        time.sleep(0.005)

    joined = "".join(p for _, p in deltas)
    assert len(deltas) >= 3, f"expected >=3 content deltas on AG-UI path, got {len(deltas)}: {deltas}"
    assert "标题" in joined
    assert "段落一" in joined
    assert "段落二" in joined
    assert "段落三" in joined
    # Not a single dump: at least two separate pieces
    assert max(len(p) for _, p in deltas) < len(joined)
