"""ACP event bus helpers.

Standardizes ACP event family and emits legacy task events for compatibility.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


async def emit_acp_status_update(
    *,
    main_task_id: str | None,
    provider: str,
    supervisor_session_id: str | None,
    subtask_id: str | None,
    status: str,
    error: str | None = None,
) -> None:
    payload = {
        "provider": provider,
        "supervisor_session_id": supervisor_session_id,
        "subtask_id": subtask_id,
        "status": status,
        "error": error,
    }
    await _emit(main_task_id, "acp_status_update", payload)


async def emit_acp_stream_delta(
    *,
    main_task_id: str | None,
    provider: str,
    supervisor_session_id: str | None,
    subtask_id: str | None,
    chunk: str,
    progressive_text: str | None = None,
) -> None:
    payload = {
        "provider": provider,
        "supervisor_session_id": supervisor_session_id,
        "subtask_id": subtask_id,
        "chunk": chunk,
    }
    await _emit(main_task_id, "acp_stream_delta", payload)
    if main_task_id and subtask_id:
        # Legacy-compatible running event for existing frontend consumers.
        await _emit(
            main_task_id,
            "task:running",
            {
                "task_id": subtask_id,
                "collab_subtask_id": subtask_id,
                "subagent_type": provider,
                # IMPORTANT: push incremental delta only.
                # Using progressive_text causes repeated "full paragraph" frames.
                "message": {"type": "ai", "content": chunk},
            },
        )


async def emit_acp_stream_done(
    *,
    main_task_id: str | None,
    provider: str,
    supervisor_session_id: str | None,
    subtask_id: str | None,
    result: str,
) -> None:
    payload = {
        "provider": provider,
        "supervisor_session_id": supervisor_session_id,
        "subtask_id": subtask_id,
        "result": result,
    }
    await _emit(main_task_id, "acp_stream_done", payload)
    if main_task_id and subtask_id:
        await _emit(
            main_task_id,
            "task:completed",
            {
                "task_id": subtask_id,
                "collab_subtask_id": subtask_id,
                "subagent_type": provider,
                "result": result,
            },
        )
        # Keep old frontend consumers alive.
        await _emit(main_task_id, "task:progress", {"task_id": subtask_id, "current_step": "ACP streamed response", "progress": 95})


async def emit_acp_stream_error(
    *,
    main_task_id: str | None,
    provider: str,
    supervisor_session_id: str | None,
    subtask_id: str | None,
    error: str,
) -> None:
    payload = {
        "provider": provider,
        "supervisor_session_id": supervisor_session_id,
        "subtask_id": subtask_id,
        "error": error,
    }
    await _emit(main_task_id, "acp_stream_error", payload)
    if main_task_id and subtask_id:
        await _emit(main_task_id, "task:failed", {"task_id": subtask_id, "error": error})


async def _emit(main_task_id: str | None, event_type: str, data: dict[str, Any]) -> None:
    if not main_task_id:
        return
    try:
        from evoflow.collab.sse_notify import broadcast_collab_task_event

        await broadcast_collab_task_event(main_task_id, event_type, data)
    except Exception:
        logger.debug("acp event emit failed: %s", event_type, exc_info=True)
