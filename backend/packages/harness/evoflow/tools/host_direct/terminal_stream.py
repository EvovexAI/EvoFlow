"""Stream terminal execution progress to the UI via LangGraph custom events."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

StreamWriter = Callable[[dict[str, Any]], Any]
_MAX_CHUNK = 8192


def capture_stream_writer() -> StreamWriter | None:
    """Capture LangGraph custom-stream writer (same path as prefetch / task_tool)."""
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
        logger.debug("terminal stream event skipped: %s", exc)


def emit_terminal_start(
    *,
    invocation_id: str,
    tool_call_id: str,
    command: str,
    stream_writer: StreamWriter | None = None,
) -> None:
    iid = str(invocation_id or "").strip()
    tc = str(tool_call_id or "").strip()
    if not tc:
        return
    _emit(
        {"type": "terminal_start", "invocation_id": iid, "tool_call_id": tc, "command": str(command or "")[:4000]},
        stream_writer=stream_writer,
    )


def emit_terminal_stdout(
    *,
    invocation_id: str,
    tool_call_id: str,
    text: str,
    stream_writer: StreamWriter | None = None,
) -> None:
    iid = str(invocation_id or "").strip()
    tc = str(tool_call_id or "").strip()
    chunk = str(text or "")
    if not tc or not chunk:
        return
    _emit(
        {"type": "terminal_stdout", "invocation_id": iid, "tool_call_id": tc, "text": chunk[:_MAX_CHUNK]},
        stream_writer=stream_writer,
    )


def emit_terminal_stderr(
    *,
    invocation_id: str,
    tool_call_id: str,
    text: str,
    stream_writer: StreamWriter | None = None,
) -> None:
    iid = str(invocation_id or "").strip()
    tc = str(tool_call_id or "").strip()
    chunk = str(text or "")
    if not tc or not chunk:
        return
    _emit(
        {"type": "terminal_stderr", "invocation_id": iid, "tool_call_id": tc, "text": chunk[:_MAX_CHUNK]},
        stream_writer=stream_writer,
    )


def emit_terminal_exit(
    *,
    invocation_id: str,
    tool_call_id: str,
    exit_code: int,
    success: bool | None = None,
    stream_writer: StreamWriter | None = None,
) -> None:
    iid = str(invocation_id or "").strip()
    tc = str(tool_call_id or "").strip()
    if not tc:
        return
    ok = success if success is not None else exit_code == 0
    _emit(
        {
            "type": "terminal_exit",
            "invocation_id": iid,
            "tool_call_id": tc,
            "exit_code": int(exit_code),
            "success": ok,
        },
        stream_writer=stream_writer,
    )
