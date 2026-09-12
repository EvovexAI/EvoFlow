"""ui_sse query must drive interactive multitask interrupt (HOL / 准备中)."""

from __future__ import annotations

from app.gateway.streaming.post_stream_ui_normalize import ui_sse_enabled_from_query
from evoflow.langgraph_run_config import apply_interactive_chat_multitask_strategy


def test_ui_sse_query_forces_interrupt_like_gateway_wiring():
    # Gateway must use ui_sse (not mirror_stream_resume alone) for ui_stream.
    ui_stream = bool(ui_sse_enabled_from_query("ui_sse=1&stream_format=agui")) or False
    body = {"multitask_strategy": "enqueue", "context": {"source": "web"}}
    out, meta = apply_interactive_chat_multitask_strategy(body, ui_stream=ui_stream)
    assert ui_stream is True
    assert out["multitask_strategy"] == "interrupt"
    assert meta["reason"] == "ui_stream"


def test_mirror_alone_without_ui_sse_still_counts_as_stream():
    # Resume/tee also counts as interactive when mirror_stream_resume is on.
    ui_stream = bool(ui_sse_enabled_from_query("ui_sse=0")) or True
    body = {"multitask_strategy": "enqueue"}
    out, meta = apply_interactive_chat_multitask_strategy(body, ui_stream=ui_stream)
    assert out["multitask_strategy"] == "interrupt"
    assert meta["reason"] == "ui_stream"
