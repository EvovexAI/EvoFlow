"""Bridge scheduler prefetch (post_search reads) into subagent ``task_running`` tool rows."""

from __future__ import annotations

import contextvars
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

StreamWriter = Callable[[dict[str, Any]], Any]

_SUBAGENT_STREAM_TASK_ID: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "_SUBAGENT_STREAM_TASK_ID",
    default=None,
)


@contextmanager
def subagent_stream_task_id_ctx(task_id: str | None) -> Iterator[None]:
    """Bind the active ``task`` / ``subagent`` background task id for scheduler UI bridging."""
    tid = str(task_id or "").strip()
    if not tid:
        yield
        return
    tok = _SUBAGENT_STREAM_TASK_ID.set(tid)
    try:
        yield
    finally:
        _SUBAGENT_STREAM_TASK_ID.reset(tok)


def get_subagent_stream_task_id() -> str | None:
    tid = str(_SUBAGENT_STREAM_TASK_ID.get() or "").strip()
    return tid or None


def bridge_prefetch_tool_calls_to_subagent_stream(
    calls: list[dict[str, str | int]],
    *,
    stream_writer: StreamWriter | None,
) -> None:
    """Mirror prefetch read stubs as LangGraph-shaped ``task_running`` messages for subagent UI."""
    tid = get_subagent_stream_task_id()
    if not tid or not calls or not stream_writer:
        return
    tool_calls = []
    for row in calls:
        if not isinstance(row, dict):
            continue
        tc_id = str(row.get("tool_call_id") or "").strip()
        path = str(row.get("path") or "").strip()
        if not tc_id or not path:
            continue
        tool_name = str(row.get("tool_name") or "read_file").strip() or "read_file"
        tool_calls.append({"id": tc_id, "name": tool_name, "args": {"path": path}})
    if not tool_calls:
        return
    try:
        stream_writer(
            {
                "type": "task_running",
                "task_id": tid,
                "message": {"type": "ai", "tool_calls": tool_calls},
            },
        )
    except Exception:
        pass


def bridge_prefetch_tool_result_to_subagent_stream(
    *,
    tool_call_id: str,
    path: str,
    ok: bool,
    output_preview: str,
    tool_name: str = "read_file",
    stream_writer: StreamWriter | None,
) -> None:
    tid = get_subagent_stream_task_id()
    if not tid or not stream_writer:
        return
    tc_id = str(tool_call_id or "").strip()
    if not tc_id:
        return
    preview = str(output_preview or "").strip() or ("OK" if ok else "Error")
    try:
        stream_writer(
            {
                "type": "task_running",
                "task_id": tid,
                "message": {
                    "type": "tool",
                    "tool_call_id": tc_id,
                    "name": str(tool_name or "read_file").strip() or "read_file",
                    "content": preview,
                },
            },
        )
    except Exception:
        pass
