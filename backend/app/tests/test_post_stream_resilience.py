"""PostStreamUiTransform stream resilience.

Per-frame errors in the chat-panel SSE pipeline (PostStreamUiTransform —
which wraps Ui / OpenAI / AgUi normalizers) must NOT terminate the entire
stream. Same class of bug as the fix in sse_ui_normalize.normalize_langgraph_sse_stream.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from app.gateway.streaming.post_stream_ui_normalize import PostStreamUiTransform


def _sse_body(event: str, data: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


async def _async_false(_tid: str) -> bool:
    return False


async def _async_true(_tid: str) -> bool:
    return True


def test_defer_completion_poll_interval_backoff() -> None:
    from app.gateway.streaming.post_stream_ui_normalize import defer_completion_poll_interval

    first = defer_completion_poll_interval(0)
    later = defer_completion_poll_interval(6)
    assert first <= later


def test_strip_fixed_length_response_headers() -> None:
    from app.gateway.streaming.post_stream_ui_normalize import _strip_fixed_length_response_headers

    headers = [
        (b"content-type", b"text/event-stream"),
        (b"Content-Length", b"128"),
        (b"transfer-encoding", b"chunked"),
        (b"cache-control", b"no-cache"),
    ]
    out = _strip_fixed_length_response_headers(headers)
    names = {k.lower() for k, _ in out}
    assert b"content-type" in names
    assert b"cache-control" in names
    assert b"content-length" not in names
    assert b"transfer-encoding" not in names


def test_process_asgi_start_drops_content_length() -> None:
    transform = PostStreamUiTransform(thread_id="t1", body=b"", stream_format="agui")
    start = {
        "type": "http.response.start",
        "status": 200,
        "headers": [
            (b"content-type", b"text/event-stream"),
            (b"content-length", b"10"),
        ],
    }

    async def _collect():
        return [msg async for msg in transform.process_asgi_message(start)]

    out = asyncio.run(_collect())
    assert len(out) == 1
    names = {k.lower() for k, _ in out[0]["headers"]}
    assert b"content-length" not in names
    assert b"x-evoflow-stream-format" in names


def test_invalidate_defer_run_finished_cache() -> None:
    import time

    from app.gateway.streaming.post_stream_ui_normalize import (
        _DEFER_CACHE,
        invalidate_defer_run_finished_cache,
    )

    _DEFER_CACHE["tid-cache-test"] = (time.monotonic(), True)
    invalidate_defer_run_finished_cache("tid-cache-test")
    assert "tid-cache-test" not in _DEFER_CACHE


async def _drive_asgi(transform: PostStreamUiTransform, chunks: list[bytes]) -> list[dict[str, Any]]:
    """Drive process_asgi_message + close_stream (the real path used in app.py)."""
    out: list[dict[str, Any]] = []
    # start frame
    start = {
        "type": "http.response.start",
        "status": 200,
        "headers": [(b"content-type", b"text/event-stream")],
    }
    async for msg in transform.process_asgi_message(start):
        out.append(msg)
    # body chunks
    for i, c in enumerate(chunks):
        more = i < len(chunks) - 1
        async for msg in transform.process_asgi_message(
            {"type": "http.response.body", "body": c, "more_body": more}
        ):
            out.append(msg)
    # close_stream is invoked by app.py's finally block in production; mirror that.
    async for msg in transform.close_stream():
        out.append(msg)
    return out


def test_post_stream_feed_frame_exception_does_not_terminate(monkeypatch: pytest.MonkeyPatch) -> None:
    """A poisoned messages frame raises inside feed_frame; later values/end must still emit."""

    transform = PostStreamUiTransform(thread_id="tid-resilience", body=b"", stream_format="agui")

    call_log: list[str] = []
    original_feed = transform.normalizer.feed_frame  # type: ignore[union-attr]

    def flaky(event_name: str, data: Any):
        call_log.append(event_name)
        if isinstance(data, dict) and data.get("__poison__"):
            raise RuntimeError("simulated frame slim failure")
        return original_feed(event_name, data)

    monkeypatch.setattr(transform.normalizer, "feed_frame", flaky)

    upstream_chunks = [
        _sse_body("metadata", {"run_id": "r1"}),
        _sse_body("messages", {"__poison__": True, "id": "ai-1"}),
        _sse_body("values", {"messages": [], "title": "after-poison"}),
        _sse_body("end", {"usage": {"input_tokens": 1, "output_tokens": 2}}),
    ]

    msgs = asyncio.run(_drive_asgi(transform, upstream_chunks))

    # All 4 upstream events must have been delivered to feed_frame even after the
    # poisoned one raised — otherwise the stream silently truncated.
    assert call_log == ["metadata", "messages", "values", "end"], (
        f"feed_frame should be called for every frame, got {call_log}"
    )

    # The transform must not have raised and must have produced at least one
    # http.response.body frame after the poisoned one.
    body_payloads = [m.get("body", b"") for m in msgs if m.get("type") == "http.response.body"]
    joined = b"".join(body_payloads).decode("utf-8", errors="ignore")
    assert joined, "transform produced no output at all"
    # We expect to see either the post-poison values frame's signature or a run_end
    # (depending on normalizer anchoring); both prove the stream did not terminate.
    assert ("after-poison" in joined) or ("run_end" in joined), (
        f"stream truncated after poisoned frame; output={joined[:600]!r}"
    )


def test_post_stream_finish_exception_does_not_break_close(monkeypatch: pytest.MonkeyPatch) -> None:
    """normalizer.finish() raising must NOT bubble out of _finish_normalizer."""

    transform = PostStreamUiTransform(thread_id="tid-finish", body=b"", stream_format="agui")

    def boom():
        raise RuntimeError("finish blew up")

    monkeypatch.setattr(transform.normalizer, "finish", boom)

    # Drive a normal start + one upstream chunk with more_body=False so _finish_normalizer runs.
    upstream_chunks = [_sse_body("metadata", {"run_id": "rx"})]
    msgs = asyncio.run(_drive_asgi(transform, upstream_chunks))

    # Must reach final more_body=False frame without raising.
    terminators = [m for m in msgs if m.get("type") == "http.response.body" and not m.get("more_body", True)]
    assert terminators, "stream never produced a terminator frame after finish() failure"


def test_post_stream_feed_frame_error_emits_diagnostic_comment_and_traceback(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A crashing frame surfaces (a) ERROR log w/ traceback, (b) SSE comment on the wire."""
    import logging as _logging

    transform = PostStreamUiTransform(thread_id="tid-diag", body=b"", stream_format="agui")

    original_feed = transform.normalizer.feed_frame  # type: ignore[union-attr]

    def flaky(event_name: str, data: Any):
        if isinstance(data, dict) and data.get("__poison__"):
            raise RuntimeError("post-stream-poison-xyz")
        return original_feed(event_name, data)

    monkeypatch.setattr(transform.normalizer, "feed_frame", flaky)

    upstream_chunks = [
        _sse_body("metadata", {"run_id": "r1"}),
        _sse_body("messages", {"__poison__": True, "id": "ai-bad"}),
        _sse_body("end", {}),
    ]

    with caplog.at_level(_logging.ERROR, logger="app.gateway.streaming.post_stream_ui_normalize"):
        msgs = asyncio.run(_drive_asgi(transform, upstream_chunks))

    body_payloads = [m.get("body", b"") for m in msgs if m.get("type") == "http.response.body"]
    joined = b"".join(body_payloads).decode("utf-8", errors="ignore")

    # (a) Diagnostic SSE comment frame visible on the wire.
    assert ": [post-stream-ui][feed_frame error]" in joined, (
        f"expected diagnostic SSE comment frame; wire={joined[:600]!r}"
    )
    assert "post-stream-poison-xyz" in joined
    assert "event=messages" in joined

    # (b) ERROR log with full traceback.
    matching = [r for r in caplog.records if "feed_frame raised" in r.getMessage()]
    assert matching, "expected an ERROR log for the raised frame"
    log_text = matching[0].getMessage()
    assert "RuntimeError" in log_text
    assert "post-stream-poison-xyz" in log_text
    assert "Traceback" in log_text, f"expected full traceback in log; got: {log_text[:500]!r}"
    assert "tid=tid-diag" in log_text
    assert "fmt=agui" in log_text
    assert "data_preview=" in log_text


def test_post_stream_mirror_enabled_enqueues_out_frames(monkeypatch: pytest.MonkeyPatch) -> None:
    """mirror_enabled writes the same outbound UI frames via stream_mirror."""
    enqueued: list[tuple[str, bytes, str | None]] = []

    def fake_enqueue(thread_id: str, chunk: bytes | str, *, run_id=None, session_key=None, source=None, **_kw) -> None:
        enqueued.append((thread_id, chunk if isinstance(chunk, bytes) else chunk.encode(), run_id))

    monkeypatch.setattr(
        "app.gateway.streaming.stream_mirror.enqueue_wire_chunk_sync",
        fake_enqueue,
    )

    transform = PostStreamUiTransform(
        thread_id="tid-mirror",
        body=b"",
        stream_format="agui",
        run_id="run-m1",
        mirror_enabled=True,
    )
    upstream_chunks = [_sse_body("metadata", {"run_id": "run-m1"})]
    asyncio.run(_drive_asgi(transform, upstream_chunks))

    assert enqueued, "expected mirror enqueue when mirror_enabled=True"
    assert enqueued[0][0] == "tid-mirror"
    assert enqueued[0][2] == "run-m1"
    assert b"event: ag-ui" in enqueued[0][1] or b"RUN_FINISHED" in enqueued[0][1] or b"run_end" in enqueued[0][1]


async def _drive_asgi_no_close(transform: PostStreamUiTransform, chunks: list[bytes]) -> list[dict[str, Any]]:
    """Drive process_asgi_message only (no close_stream) — mirrors upstream-close finish path."""
    out: list[dict[str, Any]] = []
    start = {
        "type": "http.response.start",
        "status": 200,
        "headers": [(b"content-type", b"text/event-stream")],
    }
    async for msg in transform.process_asgi_message(start):
        out.append(msg)
    for i, c in enumerate(chunks):
        more = i < len(chunks) - 1
        async for msg in transform.process_asgi_message(
            {"type": "http.response.body", "body": c, "more_body": more}
        ):
            out.append(msg)
    return out


def test_mirror_lane_upstream_close_emits_run_finished_when_no_defer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Middle layer: normal turn completion must emit RUN_FINISHED when building upstream close."""
    monkeypatch.setattr(
        "app.gateway.streaming.post_stream_ui_normalize._should_defer_run_finished_async",
        _async_false,
    )
    transform = PostStreamUiTransform(
        thread_id="tid-ml-finish",
        body=b"",
        stream_format="agui",
        mirror_lane_owned=True,
    )
    upstream_chunks = [
        _sse_body("metadata", {"run_id": "r-ml-1"}),
        _sse_body("end", {"usage": {"input_tokens": 1, "output_tokens": 2}}),
    ]
    msgs = asyncio.run(_drive_asgi_no_close(transform, upstream_chunks))

    assert transform._run_end_emitted is True
    body_payloads = [m.get("body", b"") for m in msgs if m.get("type") == "http.response.body"]
    joined = b"".join(body_payloads).decode("utf-8", errors="ignore")
    assert "RUN_FINISHED" in joined


def test_mirror_lane_upstream_close_defers_run_finished_when_tool_pause(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tool-approval pause must defer finish() fallback until close_stream after resume."""
    monkeypatch.setattr(
        "app.gateway.streaming.post_stream_ui_normalize._should_defer_run_finished_async",
        _async_true,
    )
    transform = PostStreamUiTransform(
        thread_id="tid-ml-defer",
        body=b"",
        stream_format="agui",
        mirror_lane_owned=True,
    )
    # Metadata only — no LangGraph ``end`` frame, so RUN_FINISHED depends on finish() fallback.
    upstream_chunks = [_sse_body("metadata", {"run_id": "r-ml-2"})]
    msgs = asyncio.run(_drive_asgi_no_close(transform, upstream_chunks))

    assert transform._run_end_emitted is False
    body_payloads = [m.get("body", b"") for m in msgs if m.get("type") == "http.response.body"]
    joined = b"".join(body_payloads).decode("utf-8", errors="ignore")
    assert "RUN_FINISHED" not in joined
