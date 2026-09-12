"""Live browser viewport stream (agent-browser WebSocket proxy)."""

from __future__ import annotations

import asyncio
import logging
import threading
import time

from fastapi import Request, APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from evoflow.authz.http_guard import require_thread_visible
from fastapi.responses import Response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/threads", tags=["browser-stream"])

_RESTART_MIN_INTERVAL_SEC = 2.0
_restart_last_at: dict[str, float] = {}
_restart_lock = threading.Lock()


@router.get(
    "/{thread_id}/browser-stream/status",
    summary="Get browser live stream status",
)
async def get_browser_stream_status(request: Request, thread_id: str) -> dict[str, object]:
    require_thread_visible(request, thread_id)
    from evoflow.tools.builtins.browser_stream import (
        browser_live_ws_path,
        resolve_browser_stream_port,
    )

    port = await asyncio.to_thread(resolve_browser_stream_port, thread_id)
    if not port:
        raise HTTPException(status_code=404, detail="No active browser stream")
    return {
        "thread_id": thread_id,
        "port": port,
        "stream_ws": browser_live_ws_path(thread_id),
        "live": True,
    }


@router.post(
    "/{thread_id}/browser-stream/restart",
    summary="Restart browser live screencast",
)
async def restart_browser_stream_route(request: Request, thread_id: str) -> dict[str, object]:
    require_thread_visible(request, thread_id)
    from evoflow.tools.builtins.browser_screenshot_store import _safe_thread_segment
    from evoflow.tools.builtins.browser_stream import (
        browser_live_ws_path,
        restart_browser_stream,
    )

    key = _safe_thread_segment(thread_id)
    now = time.time()
    with _restart_lock:
        last = _restart_last_at.get(key, 0.0)
        if now - last < _RESTART_MIN_INTERVAL_SEC:
            raise HTTPException(status_code=429, detail="Browser stream restart rate limited")
        _restart_last_at[key] = now

    port = await asyncio.to_thread(restart_browser_stream, thread_id)
    if not port:
        raise HTTPException(status_code=404, detail="No active browser stream to restart")
    return {
        "thread_id": thread_id,
        "port": port,
        "stream_ws": browser_live_ws_path(thread_id),
        "live": True,
    }


@router.websocket("/{thread_id}/browser-stream")
async def browser_stream_ws(websocket: WebSocket, thread_id: str) -> None:
    from fastapi import HTTPException
    try:
        require_thread_visible(websocket, thread_id)  # type: ignore[arg-type]
    except HTTPException:
        await websocket.close(code=1008, reason="forbidden")
        return
    from app.gateway.streaming.browser_stream_proxy import run_browser_stream_proxy

    try:
        await run_browser_stream_proxy(websocket, thread_id)
    except WebSocketDisconnect:
        return
    except Exception as exc:
        logger.warning("browser stream websocket failed thread=%s: %s", thread_id, exc)


@router.get(
    "/{thread_id}/browser-live-frame",
    summary="Deprecated — polling disabled to avoid blocking Gateway",
    deprecated=True,
)
async def get_browser_live_frame(request: Request, thread_id: str) -> Response:
    require_thread_visible(request, thread_id)
    return Response(
        status_code=410,
        content="browser-live-frame polling is disabled; use WebSocket stream or tool screenshots.",
        media_type="text/plain",
    )
