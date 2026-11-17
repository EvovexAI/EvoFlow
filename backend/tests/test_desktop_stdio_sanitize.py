"""Retarget uvicorn StreamHandlers after TextIOWrapper.detach()."""

from __future__ import annotations

import io
import logging
import sys

from evoflow.desktop_stdio import _sanitize_logging_after_stdio_fix


def test_sanitize_retargets_detached_stream_handler(monkeypatch):
    # Simulate uvicorn.access holding a detached wrapper after reconfigure_stdio_utf8.
    buf = io.BytesIO()
    old = io.TextIOWrapper(buf, encoding="utf-8", errors="replace", line_buffering=True)
    old.detach()  # leaves `old` unusable → "underlying buffer has been detached"

    sink = io.StringIO()
    monkeypatch.setattr(sys, "stderr", sink)

    log = logging.getLogger("uvicorn.access")
    handler = logging.StreamHandler(old)
    log.addHandler(handler)
    try:
        _sanitize_logging_after_stdio_fix()
        assert handler.stream is sink
        handler.emit(
            logging.LogRecord(
                name="uvicorn.access",
                level=logging.INFO,
                pathname=__file__,
                lineno=1,
                msg="ok",
                args=(),
                exc_info=None,
            )
        )
        assert "ok" in sink.getvalue()
    finally:
        log.removeHandler(handler)
        try:
            handler.close()
        except Exception:
            pass
