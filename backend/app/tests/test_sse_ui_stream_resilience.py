"""SSE stream resilience: per-frame errors must NOT terminate the entire stream.

Regression for sse_tool_error bug — previously any Exception raised inside
``normalizer.feed_frame`` bubbled to the outer ``try/except`` in
``normalize_langgraph_sse_stream`` and ``return``-ed the async generator,
silently dropping all later upstream frames (messages/values/custom/end).

After the fix a single bad frame is logged and skipped; subsequent frames
keep flowing to the client.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import pytest

from app.gateway import sse_ui_normalize as mod


def _sse(event: str, data: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


async def _bytes_iter(chunks: list[bytes]) -> AsyncIterator[bytes]:
    for c in chunks:
        yield c


def _collect(gen: AsyncIterator[bytes]) -> list[bytes]:
    async def _run() -> list[bytes]:
        return [out async for out in gen]

    return asyncio.run(_run())


def test_feed_frame_exception_does_not_terminate_stream(monkeypatch: pytest.MonkeyPatch) -> None:
    """One poisoned frame raises inside feed_frame; later frames must still emit."""

    call_log: list[str] = []
    original_feed = mod.UiStreamNormalizer.feed_frame

    def flaky_feed_frame(self: mod.UiStreamNormalizer, event_name: str, data: Any):
        call_log.append(event_name)
        if isinstance(data, dict) and data.get("__poison__"):
            raise RuntimeError("simulated tool-result slim failure")
        return original_feed(self, event_name, data)

    monkeypatch.setattr(mod.UiStreamNormalizer, "feed_frame", flaky_feed_frame)

    upstream = _bytes_iter(
        [
            _sse("metadata", {"run_id": "r1"}),
            _sse("messages", {"__poison__": True, "id": "ai-1"}),
            _sse("values", {"messages": [], "title": "after-poison"}),
            _sse("end", {"usage": {"input_tokens": 1, "output_tokens": 2}}),
        ]
    )

    gen = mod.normalize_langgraph_sse_stream(upstream, thread_id="tid-test")
    out = _collect(gen)

    # poisoned frame skipped → log saw all 4 events
    assert call_log == ["metadata", "messages", "values", "end"], (
        f"feed_frame should be called for every frame even after error, got {call_log}"
    )

    # stream must NOT have early-returned with only an error frame
    joined = b"".join(out).decode("utf-8", errors="ignore")
    assert "after-poison" in joined or "run_end" in joined, (
        f"stream terminated prematurely; output={joined[:500]!r}"
    )

    # outer except path emits exactly one ``{"type":"error",...}`` frame.
    # On the happy-skip path we MUST NOT see that early-abort error frame.
    error_frames = [line for line in joined.splitlines() if '"type": "error"' in line or '"type":"error"' in line]
    assert not error_frames, f"unexpected outer-error frame emitted: {error_frames}"


def test_outer_upstream_error_still_handled(monkeypatch: pytest.MonkeyPatch) -> None:
    """Outer try/except still wraps real upstream errors (network/cancel)."""

    async def boom() -> AsyncIterator[bytes]:
        yield _sse("metadata", {"run_id": "r1"})
        raise ConnectionError("upstream gone")

    gen = mod.normalize_langgraph_sse_stream(boom(), thread_id="tid-boom")
    out = _collect(gen)
    joined = b"".join(out).decode("utf-8", errors="ignore")
    assert "error" in joined and "upstream gone" in joined


def test_feed_frame_error_emits_diagnostic_comment_and_traceback(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A crashing frame must surface (a) ERROR log w/ traceback, (b) SSE comment on the wire."""
    import logging as _logging

    original_feed = mod.UiStreamNormalizer.feed_frame

    def flaky_feed_frame(self: mod.UiStreamNormalizer, event_name: str, data: Any):
        if isinstance(data, dict) and data.get("__poison__"):
            raise RuntimeError("poison-payload-blew-up-xyz")
        return original_feed(self, event_name, data)

    monkeypatch.setattr(mod.UiStreamNormalizer, "feed_frame", flaky_feed_frame)

    upstream = _bytes_iter(
        [
            _sse("metadata", {"run_id": "r1"}),
            _sse("messages", {"__poison__": True, "id": "ai-bad"}),
            _sse("end", {}),
        ]
    )

    with caplog.at_level(_logging.ERROR, logger="app.gateway.sse_ui_normalize"):
        gen = mod.normalize_langgraph_sse_stream(upstream, thread_id="tid-diag")
        out = _collect(gen)

    joined = b"".join(out).decode("utf-8", errors="ignore")

    # (a) SSE comment frame visible on the wire (lines starting with ":" are
    # safely ignored by EventSource but visible in browser devtools Network).
    assert ": [sse-ui][feed_frame error]" in joined, (
        f"expected diagnostic SSE comment frame; wire={joined[:600]!r}"
    )
    assert "poison-payload-blew-up-xyz" in joined, (
        f"comment frame should include exc message; wire={joined[:600]!r}"
    )
    assert "event=messages" in joined

    # (b) Server log includes full traceback so we can fix it next time.
    matching = [r for r in caplog.records if "feed_frame raised" in r.getMessage()]
    assert matching, "expected an ERROR log for the raised frame"
    log_text = matching[0].getMessage()
    assert "RuntimeError" in log_text
    assert "poison-payload-blew-up-xyz" in log_text
    assert "Traceback" in log_text, f"expected full traceback in log; got: {log_text[:500]!r}"
    assert "tid=tid-diag" in log_text
    assert "data_preview=" in log_text
