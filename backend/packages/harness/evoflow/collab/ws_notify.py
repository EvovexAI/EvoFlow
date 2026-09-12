"""Push collab / task events to Gateway EventBroadcaster (SSE + WebSocket fan-out)."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

_TASK_CUSTOM_TO_WS: dict[str, str] = {
    "task_started": "task:started",
    "task_running": "node:output",
    "task_completed": "task:completed",
    "task_failed": "task:failed",
    "task_timed_out": "task:timed_out",
}


def _json_safe_stream_payload(data: dict[str, Any]) -> dict[str, Any]:
    """Make subtask stream payloads JSON-safe for WebSocket (LangChain messages → dict)."""
    try:
        from evoflow.agents.checkpointer.thread_state_reader import _json_safe_value, _message_to_jsonable
    except ImportError:
        return dict(data)

    out: dict[str, Any] = {}
    for key, value in data.items():
        if key == "message":
            out[key] = _message_to_jsonable(value)
        else:
            out[key] = _json_safe_value(value)
    return out


def _unique_channels(*ids: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in ids:
        cid = str(raw or "").strip()
        if not cid or cid in seen:
            continue
        seen.add(cid)
        out.append(cid)
    return out


def resolve_lead_thread_id(main_task_id: str) -> str | None:
    from evoflow.collab.sse_notify import _resolve_lead_thread_id

    return _resolve_lead_thread_id(main_task_id)


async def broadcast_to_channels(channel_ids: list[str], event_type: str, data: dict[str, Any]) -> None:
    """Fan-out to in-process EventBroadcaster (WebSocket + SSE subscribers)."""
    channels = _unique_channels(*channel_ids)
    if not channels:
        return
    try:
        from app.gateway.routers.events import broadcaster

        for cid in channels:
            await broadcaster.broadcast(cid, event_type, data)
        return
    except ImportError:
        pass

    secret = (os.getenv("INTERNAL_EVENTS_SECRET") or "").strip()
    if not secret:
        return
    base = (os.getenv("EVOFLOW_GATEWAY_URL") or "http://127.0.0.1:8001").rstrip("/")
    url = f"{base}/api/events/internal/broadcast"
    payload = {"event_type": event_type, "data": data, "thread_id": channels[0]}
    try:
        import httpx

        async with httpx.AsyncClient(timeout=3.0) as client:
            await client.post(
                url,
                json=payload,
                headers={"X-Internal-Events-Secret": secret},
            )
    except Exception:
        logger.debug("ws_notify relay failed type=%s", event_type, exc_info=True)


async def broadcast_task_event(main_task_id: str, event_type: str, data: dict[str, Any]) -> None:
    """Broadcast task lifecycle/progress to both main-task id and lead thread id channels."""
    mid = str(main_task_id or "").strip()
    if not mid:
        return
    payload = dict(data)
    thread_id = resolve_lead_thread_id(mid)
    channels = [mid]
    if thread_id:
        channels.append(thread_id)
    await broadcast_to_channels(channels, event_type, payload)


def schedule_task_event_broadcast(main_task_id: str, event_type: str, data: dict[str, Any]) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(
        broadcast_task_event(main_task_id, event_type, data),
        name="collab_ws_task_event",
    )


async def emit_collab_state_changed(thread_id: str, *, snapshot: dict[str, Any] | None = None) -> None:
    """Notify subscribers that thread collab state or sidebar snapshot changed."""
    tid = str(thread_id or "").strip()
    if not tid:
        return
    if snapshot is not None:
        await broadcast_to_channels([tid], "collab:snapshot", snapshot)
        bound = str(snapshot.get("bound_task_id") or "").strip()
        if bound:
            await broadcast_to_channels([bound], "collab:snapshot", snapshot)
        return

    from evoflow.collab.task_progress_snapshot import build_task_progress_snapshot
    from evoflow.collab.thread_collab import load_thread_collab_state
    from evoflow.config.paths import get_paths

    paths = get_paths()
    collab = load_thread_collab_state(paths, tid)
    phase = collab.collab_phase.value if hasattr(collab.collab_phase, "value") else str(collab.collab_phase)
    patch = {
        "thread_id": tid,
        "collab_phase": phase,
        "bound_task_id": collab.bound_task_id,
        "updated_at": collab.updated_at,
    }
    await broadcast_to_channels([tid], "collab:state", patch)
    bound = str(collab.bound_task_id or "").strip()
    if bound:
        await broadcast_to_channels([bound], "collab:state", patch)
    try:
        snap = build_task_progress_snapshot(paths, tid)
        await broadcast_to_channels([tid], "collab:snapshot", snap)
        if bound:
            await broadcast_to_channels([bound], "collab:snapshot", snap)
    except Exception:
        logger.debug("emit_collab_state_changed snapshot failed thread=%s", tid, exc_info=True)


def schedule_collab_state_changed(thread_id: str) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(emit_collab_state_changed(tid), name="collab_ws_state")


async def broadcast_subtask_stream_payload(main_task_id: str, data: dict[str, Any]) -> None:
    """Push workflow node live output (``task_running`` messages) over WebSocket."""
    mid = str(main_task_id or "").strip()
    if not mid or not isinstance(data, dict):
        return
    inner = str(data.get("type") or "").strip()
    if inner not in _TASK_CUSTOM_TO_WS:
        return
    payload = _json_safe_stream_payload(dict(data))
    ws_type = _TASK_CUSTOM_TO_WS[inner]
    thread_id = resolve_lead_thread_id(mid)
    channels = [mid]
    if thread_id:
        channels.append(thread_id)
    await broadcast_to_channels(channels, ws_type, payload)


def schedule_subtask_stream_payload(main_task_id: str, data: dict[str, Any]) -> None:
    mid = str(main_task_id or "").strip()
    if not mid or not isinstance(data, dict):
        return

    async def _go() -> None:
        await broadcast_subtask_stream_payload(mid, data)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(_go(), name="collab_ws_node_output")


__all__ = [
    "broadcast_subtask_stream_payload",
    "broadcast_task_event",
    "broadcast_to_channels",
    "emit_collab_state_changed",
    "resolve_lead_thread_id",
    "schedule_collab_state_changed",
    "schedule_subtask_stream_payload",
    "schedule_task_event_broadcast",
]
