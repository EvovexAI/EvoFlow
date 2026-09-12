"""Stream write/replace tool progress to the UI via LangGraph custom events.

During ``write_file_hd`` / ``str_replace_hd`` we emit lightweight custom events so
the EvoPanel progress bar / diff modal updates in real time even for large writes.
The payload shape is intentionally the same as the *argument-streaming*
``write_file_progress`` already produced by ``sse_ui_normalize.py`` — the UI only
needs to handle one wire type, and the normalizer simply passes these through.

Wire event (EVF):
    {
      "type": "write_file_progress",
      "phase": "writing" | "done" | "error",
      "tool_call_id": "<id>",
      "tool_name": "write" | "replace" | ...,
      "path": "<abs-or-relative-path>",
      "bytes_total": 12345,
      "bytes_written": 12345,
      "lines_added": 99,
      "lines_removed": 0,
      "content_len": 12345,
    }

Two small deltas vs. the args-streaming payload:
  - ``phase`` tells the UI "actually writing to disk now" vs. "still building args".
  - ``bytes_total``/``bytes_written`` give an honest progress percentage.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

StreamWriter = Callable[[dict[str, Any]], Any]

# SSE frames must stay small; we send at most this many content_delta characters
# per event. Large payloads are delivered by the final ToolMessage anyway — the
# UI only needs enough to render the diff preview incrementally.
_PROGRESS_CONTENT_DELTA_MAX = 4096


def capture_stream_writer() -> StreamWriter | None:
    """Capture LangGraph custom-stream writer (same path as terminal/prefetch)."""
    try:
        from langgraph.config import get_stream_writer

        writer = get_stream_writer()
        if writer:
            return writer
    except Exception:
        pass
    try:
        from evoflow.tools.builtins.claude_session_tool import _PARENT_CHAT_STREAM_WRITER

        parent = _PARENT_CHAT_STREAM_WRITER.get()
        if parent:
            return parent
    except Exception:
        pass
    return None


def _emit(payload: dict[str, Any], *, stream_writer: StreamWriter | None = None) -> None:
    writer = stream_writer or capture_stream_writer()
    if not writer:
        return
    try:
        writer(payload)
    except Exception as exc:
        logger.debug("write stream event skipped: %s", exc)


def emit_write_progress(
    *,
    tool_call_id: str,
    tool_name: str,
    path: str,
    phase: str,
    bytes_total: int = 0,
    bytes_written: int = 0,
    lines_added: int = 0,
    lines_removed: int = 0,
    content_len: int = 0,
    content: str | None = None,
    old_string: str | None = None,
    new_string: str | None = None,
    message: str | None = None,
    stream_writer: StreamWriter | None = None,
) -> None:
    """Emit a ``write_file_progress`` custom event.

    When ``content`` is provided only ``_PROGRESS_CONTENT_DELTA_MAX`` chars are
    forwarded as ``content_delta`` to keep SSE frames small; the modal fetches
    the full text from the eventual tool result / persisted file.
    """
    tc = str(tool_call_id or "").strip()
    if not tc:
        return
    payload: dict[str, Any] = {
        "type": "write_file_progress",
        "phase": str(phase or "writing"),
        "tool_call_id": tc,
        "tool_name": str(tool_name or "write"),
        "path": str(path or ""),
        "bytes_total": int(bytes_total or 0),
        "bytes_written": int(bytes_written or 0),
        "lines_added": int(lines_added or 0),
        "lines_removed": int(lines_removed or 0),
        "content_len": int(content_len or 0),
    }
    if message:
        payload["message"] = str(message)
    if isinstance(content, str) and content:
        payload["content_delta"] = content[:_PROGRESS_CONTENT_DELTA_MAX]
    if isinstance(old_string, str) and old_string:
        payload["old_string_delta"] = old_string[:_PROGRESS_CONTENT_DELTA_MAX]
    if isinstance(new_string, str) and new_string:
        payload["new_string_delta"] = new_string[:_PROGRESS_CONTENT_DELTA_MAX]
    _emit(payload, stream_writer=stream_writer)


def count_lines(text: str) -> int:
    if not text:
        return 0
    # Strip a single trailing newline that create_line adds to avoid off-by-one.
    return text.count("\n") + (0 if text.endswith("\n") else 1)
