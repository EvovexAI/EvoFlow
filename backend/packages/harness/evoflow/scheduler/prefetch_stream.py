"""Stream prefetch read progress to the UI via LangGraph custom events."""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

StreamWriter = Callable[[dict[str, Any]], Any]

# Live SSE must stay small — full file bodies belong in disk / final tool JSON only.
_WORKER_STREAM_PREVIEW_MAX = 240


def capture_stream_writer() -> StreamWriter | None:
    """Capture LangGraph custom-stream writer (must call from sync tool before ``asyncio.run``).

    Subagents run in a thread pool without a graph writer; fall back to the lead-agent writer
    bound by ``task_tool`` via ``parent_chat_stream_writer_ctx`` (same path as claude_session).
    """
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
    writer = stream_writer
    if writer is None:
        writer = capture_stream_writer()
    if not writer:
        return
    try:
        writer(payload)
    except Exception as exc:
        logger.debug("prefetch stream event skipped: %s", exc)


def scheduler_read_tool_call_id(prefix: str, path: str, index: int) -> str:
    digest = hashlib.sha256(f"{prefix}:{index}:{path}".encode()).hexdigest()[:10]
    return f"{prefix}-{index}-{digest}"


def prefetch_tool_call_id(path: str, index: int) -> str:
    return scheduler_read_tool_call_id("prefetch-read", path, index)


def emit_prefetch_tool_call(
    *,
    tool_call_id: str,
    path: str,
    index: int,
    total: int,
    stream_writer: StreamWriter | None = None,
) -> None:
    _emit(
        {
            "type": "prefetch_tool_call",
            "tool_call_id": tool_call_id,
            "path": path,
            "index": index,
            "total": total,
        },
        stream_writer=stream_writer,
    )


def emit_prefetch_tool_calls_batch(
    calls: list[dict[str, str | int]],
    *,
    stream_writer: StreamWriter | None = None,
) -> None:
    """Emit all prefetch read_file stubs in one custom event (desktop UI shows parallel tools)."""
    if not calls:
        return
    writer = stream_writer or capture_stream_writer()
    _emit({"type": "prefetch_tool_calls_batch", "calls": calls}, stream_writer=writer)
    try:
        from evoflow.scheduler.subagent_stream import bridge_prefetch_tool_calls_to_subagent_stream

        bridge_prefetch_tool_calls_to_subagent_stream(calls, stream_writer=writer)
    except Exception:
        pass


def emit_prefetch_tool_result(
    *,
    tool_call_id: str,
    path: str,
    ok: bool,
    output_preview: str,
    index: int,
    total: int,
    tool_name: str = "read_file",
    stream_writer: StreamWriter | None = None,
    action: str | None = None,
    instruction: str | None = None,
    content: str | None = None,
    old_string: str | None = None,
    new_string: str | None = None,
    slim_preview: bool = False,
) -> None:
    preview_out = (
        ""
        if slim_preview and ok
        else str(output_preview or "")[: (_WORKER_STREAM_PREVIEW_MAX if slim_preview else 2000)]
    )
    payload: dict[str, Any] = {
        "type": "prefetch_tool_result",
        "tool_call_id": tool_call_id,
        "path": path,
        "tool_name": tool_name,
        "ok": ok,
        "output_preview": preview_out,
        "status": "success" if ok else "error",
        "index": index,
        "total": total,
    }
    if action:
        payload["action"] = action
    if instruction:
        payload["instruction"] = instruction
    if content is not None:
        payload["content"] = content
    if old_string is not None:
        payload["old_string"] = old_string
    if new_string is not None:
        payload["new_string"] = new_string
    writer = stream_writer or capture_stream_writer()
    _emit(payload, stream_writer=writer)
    try:
        from evoflow.scheduler.subagent_stream import bridge_prefetch_tool_result_to_subagent_stream

        bridge_prefetch_tool_result_to_subagent_stream(
            tool_call_id=tool_call_id,
            path=path,
            ok=ok,
            output_preview=output_preview,
            tool_name=tool_name,
            stream_writer=writer,
        )
    except Exception:
        pass


def emit_worker_file_completed(
    *,
    parent_tool_call_id: str,
    tool_call_id: str,
    path: str,
    ok: bool,
    output_preview: str,
    index: int,
    total: int,
    tool_name: str = "write_to_file",
    stream_writer: StreamWriter | None = None,
    action: str | None = None,
    instruction: str | None = None,
    content: str | None = None,
    old_string: str | None = None,
    new_string: str | None = None,
    before_content: str | None = None,
    after_content: str | None = None,
    query: str | None = None,
    inner_tools: list[dict[str, Any]] | None = None,
) -> None:
    """Push per-file worker completion to the live chat stream (parent worker UI).

    Intentionally **does not** include ``before_content`` / ``after_content`` — those
    blow up SSE frames and freeze the panel. UI diff uses ``old_string`` / ``new_string``
    / ``content``; full snapshots remain in ``<worker_file_results>`` JSON when needed.
    """
    preview_out = (
        ""
        if ok
        else str(output_preview or "")[:_WORKER_STREAM_PREVIEW_MAX]
    )
    payload: dict[str, Any] = {
        "type": "worker_file_completed",
        "parent_tool_call_id": parent_tool_call_id,
        "tool_call_id": tool_call_id,
        "path": path,
        "tool_name": tool_name,
        "ok": ok,
        "output_preview": preview_out,
        "status": "success" if ok else "error",
        "index": index,
        "total": total,
    }
    if action:
        payload["action"] = action
    if instruction:
        payload["instruction"] = instruction
    if content is not None:
        payload["content"] = content
    if old_string is not None:
        payload["old_string"] = old_string
    if new_string is not None:
        payload["new_string"] = new_string
    if query:
        payload["query"] = query
    if inner_tools:
        payload["inner_tools"] = inner_tools
    writer = stream_writer or capture_stream_writer()
    _emit(payload, stream_writer=writer)
