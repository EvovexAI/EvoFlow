"""App-server stream event filtering + serialize cost sanity checks."""

from __future__ import annotations

import json
import time

from evoflow.app_server.chat_bridge import should_forward_stream_event


def test_ui_wire_drops_fat_langgraph_modes():
    q = {"ui_sse": "1", "stream_format": "agui"}
    assert should_forward_stream_event("ag-ui", q) is True
    assert should_forward_stream_event("evf", q) is True
    assert should_forward_stream_event("error", q) is True
    assert should_forward_stream_event("values", q) is False
    assert should_forward_stream_event("messages", q) is False
    assert should_forward_stream_event("messages-tuple", q) is False
    assert should_forward_stream_event("custom", q) is False


def test_legacy_without_ui_sse_forwards_all():
    assert should_forward_stream_event("values", {}) is True
    assert should_forward_stream_event("messages-tuple", None) is True


def test_values_jsonrpc_serialize_dwarfs_agui_delta():
    """Regression signal: forwarding values snapshots over stdio is the slow path."""
    values_payload = {
        "messages": [
            {
                "type": "ai",
                "content": "x" * 8000,
                "tool_calls": [
                    {"id": f"c{i}", "name": "tool", "args": {"n": i, "blob": "y" * 200}}
                    for i in range(40)
                ],
            }
        ]
        * 5
    }
    agui_delta = {"type": "TEXT_MESSAGE_CONTENT", "delta": "你好"}

    def _rpc_line(event: str, data: object) -> str:
        return json.dumps(
            {"method": "stream/event", "params": {"event": event, "data": data, "turnId": "t1"}},
            ensure_ascii=False,
            separators=(",", ":"),
        )

    n = 80
    t0 = time.perf_counter()
    values_bytes = 0
    for _ in range(n):
        line = _rpc_line("values", values_payload)
        values_bytes += len(line.encode("utf-8"))
    values_ms = (time.perf_counter() - t0) * 1000

    t1 = time.perf_counter()
    agui_bytes = 0
    for _ in range(n):
        line = _rpc_line("ag-ui", agui_delta)
        agui_bytes += len(line.encode("utf-8"))
    agui_ms = (time.perf_counter() - t1) * 1000

    # Fat values lines should be orders of magnitude larger; if this fails, payloads changed.
    assert values_bytes > agui_bytes * 50
    # Soft timing check — mainly documents the cost; avoid flaking on busy CI.
    assert values_ms >= agui_ms or values_bytes > agui_bytes * 100
