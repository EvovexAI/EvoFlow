"""Unified collab subtask streaming — same ``task_*`` custom events as the main LangGraph chat stream.

Follow-up DAG waves run outside an active LangGraph runnable, so ``get_stream_writer()`` is often
unset. We always attach a gateway SSE writer on the lead ``ToolRuntime`` so ``task_tool`` and
Claude delegation emit the same payload shape the frontend already merges via ``mergeSubagentStreamEvent``.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

StreamWriter = Callable[[dict[str, Any]], None]


def _chain_writers(*writers: StreamWriter | None) -> StreamWriter | None:
    fns = [w for w in writers if callable(w)]
    if not fns:
        return None

    def writer(message: dict[str, Any]) -> None:
        for fn in fns:
            try:
                fn(message)
            except Exception:
                logger.debug("collab unified_stream writer failed", exc_info=True)

    return writer


def attach_gateway_writer_to_runtime(runtime: Any, main_task_id: str) -> None:
    """Ensure detached follow-up waves can emit ``task_*`` events like wave-1 (main chat custom)."""
    from evoflow.collab.sse_notify import make_gateway_task_stream_writer

    mid = str(main_task_id or "").strip()
    if not mid or runtime is None:
        return
    gw = make_gateway_task_stream_writer(mid)
    prev = getattr(runtime, "stream_writer", None)
    combined = _chain_writers(prev if callable(prev) else None, gw)
    if combined is None:
        return
    try:
        runtime.stream_writer = combined
    except Exception:
        try:
            object.__setattr__(runtime, "stream_writer", combined)
        except Exception:
            logger.debug("attach_gateway_writer_to_runtime: could not set stream_writer", exc_info=True)


def resolve_collab_parent_stream_writer(
    *,
    runtime: Any | None,
    main_task_id: str | None,
    thread_id: str | None = None,
) -> StreamWriter | None:
    """Resolve writer for collab subtask ``task_tool`` — LangGraph custom + gateway SSE."""
    from langgraph.config import get_stream_writer

    from evoflow.collab.sse_notify import make_gateway_task_stream_writer

    writers: list[StreamWriter] = []
    has_lg = False

    try:
        lg = get_stream_writer()
        if callable(lg):
            writers.append(lg)
            has_lg = True
    except Exception:
        pass

    has_rt = False
    if runtime is not None:
        sw = getattr(runtime, "stream_writer", None)
        if callable(sw) and sw not in writers:
            writers.append(sw)
            has_rt = True

    mid = str(main_task_id or "").strip()
    has_gw = False
    if mid:
        gw = make_gateway_task_stream_writer(mid)
        if gw not in writers:
            writers.append(gw)
            has_gw = True

    combined = _chain_writers(*writers)
    if mid:
        try:
            from evoflow.collab.subtask_stream_trace import stream_info

            stream_info(
                "resolve_writers main=%s thread=%s langgraph=%s runtime=%s gateway=%s combined=%s",
                mid,
                str(thread_id or "").strip() or "-",
                has_lg,
                has_rt,
                has_gw,
                combined is not None,
            )
        except Exception:
            pass
    return combined


async def emit_collab_subtask_lifecycle(
    *,
    runtime: Any | None,
    main_task_id: str,
    subtask_id: str,
    event: str,
    description: str = "",
    subagent_type: str = "",
    message: dict[str, Any] | None = None,
) -> bool:
    """Emit ``task_started`` / ``task_running`` on the unified collab stream writer."""
    from evoflow.collab.sse_notify import broadcast_collab_subtask_stream

    mid = str(main_task_id or "").strip()
    sid = str(subtask_id or "").strip()
    if not mid or not sid:
        return False

    type_map = {
        "started": "task_started",
        "running": "task_running",
        "completed": "task_completed",
        "failed": "task_failed",
    }
    msg_type = type_map.get(str(event or "").strip().lower())
    if not msg_type:
        return False

    payload: dict[str, Any] = {
        "type": msg_type,
        "task_id": sid,
        "collab_subtask_id": sid,
        "description": description or sid,
    }
    if subagent_type:
        payload["subagent_type"] = subagent_type
    if message:
        payload["message"] = message

    writer = resolve_collab_parent_stream_writer(runtime=runtime, main_task_id=mid)
    if writer is not None:
        try:
            writer(payload)
            return True
        except Exception:
            logger.debug("emit_collab_subtask_lifecycle writer failed", exc_info=True)

    sse_map = {
        "task_started": "task:started",
        "task_running": "task:running",
        "task_completed": "task:completed",
        "task_failed": "task:failed",
    }
    await broadcast_collab_subtask_stream(
        mid,
        sse_map[msg_type],
        subtask_id=sid,
        description=description or sid,
        subagent_type=subagent_type or None,
        message=message,
    )
    return False


__all__ = [
    "attach_gateway_writer_to_runtime",
    "emit_collab_subtask_lifecycle",
    "resolve_collab_parent_stream_writer",
]
