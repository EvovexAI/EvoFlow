"""Push live agent phase hints into the active LangGraph ``runs/stream`` (custom channel)."""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

logger = logging.getLogger(__name__)

_last_detail_by_thread: dict[str, str] = {}
_lock = threading.Lock()


def _detail_changed(thread_id: str, detail: str) -> bool:
    tid = str(thread_id or "").strip()
    d = str(detail or "").strip()
    if not tid or not d:
        return False
    with _lock:
        if _last_detail_by_thread.get(tid) == d:
            return False
        _last_detail_by_thread[tid] = d
        return True


def clear_agent_activity(thread_id: str) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    with _lock:
        _last_detail_by_thread.pop(tid, None)


def _payload(
    *,
    kind: str,
    detail: str,
    tool_name: str | None = None,
    tool_calls: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "type": "agent_activity",
        "kind": str(kind or "system").strip() or "system",
        "detail": str(detail or "").strip(),
    }
    if tool_name:
        out["tool_name"] = str(tool_name).strip()
    if tool_calls:
        out["tool_calls"] = [c for c in tool_calls if isinstance(c, dict)]
    return out


def _try_stream_writer(payload: dict[str, Any]) -> bool:
    try:
        from langgraph.config import get_stream_writer

        writer = get_stream_writer()
    except Exception:
        return False
    if not writer:
        return False
    try:
        writer(payload)
        return True
    except Exception:
        logger.debug("agent_activity stream_writer failed", exc_info=True)
        return False


def _schedule_http_inject(thread_id: str, payload: dict[str, Any]) -> None:
    async def _go() -> None:
        secret = (os.getenv("INTERNAL_EVENTS_SECRET") or "").strip()
        if not secret:
            return
        base = (os.getenv("EVOFLOW_GATEWAY_URL") or "http://127.0.0.1:8001").rstrip("/")
        url = f"{base}/api/events/internal/inject-evf"
        try:
            import httpx

            async with httpx.AsyncClient(timeout=3.0) as client:
                await client.post(
                    url,
                    json={"thread_id": thread_id, "payload": payload},
                    headers={"X-Internal-Events-Secret": secret},
                )
        except Exception:
            logger.debug("agent_activity http inject failed thread=%s", thread_id, exc_info=True)

    # NEVER create_task on the LangGraph job loop — make_lead/set_live_progress runs
    # inside astream_state; those httpx tasks then starve the 1.4s ready→metadata gap.
    try:
        from evoflow.subagents.detached_poll_scheduler import schedule_detached_poll

        schedule_detached_poll(_go(), name="agent_activity_inject")
    except Exception:
        logger.debug("agent_activity inject schedule failed", exc_info=True)


def emit_agent_activity(
    thread_id: str,
    *,
    kind: str,
    detail: str,
    tool_name: str | None = None,
    tool_calls: list[dict[str, Any]] | None = None,
    force: bool = False,
) -> None:
    """Emit a phase hint (model prep / model call / tool execution) into the live SSE stream."""
    tid = str(thread_id or "").strip()
    d = str(detail or "").strip()
    if not tid or not d:
        return
    if not force and not _detail_changed(tid, d):
        return
    payload = _payload(kind=kind, detail=d, tool_name=tool_name, tool_calls=tool_calls)
    if _try_stream_writer(payload):
        return
    inject: dict[str, Any] = {
        "type": "activity",
        "kind": payload["kind"],
        "detail": d,
    }
    if tool_name:
        inject["tool_name"] = tool_name
    if tool_calls:
        inject["tool_calls"] = [c for c in tool_calls if isinstance(c, dict)]
    try:
        from app.gateway.streaming.session_stream_inject import schedule_inject_evf_frame
        from app.gateway.streaming.stream_middle_layer import middle_layer_covers_thread

        if middle_layer_covers_thread(tid):
            schedule_inject_evf_frame(tid, inject)
            return
    except Exception:
        logger.debug("agent_activity direct inject failed thread=%s", tid, exc_info=True)
    _schedule_http_inject(tid, inject)
