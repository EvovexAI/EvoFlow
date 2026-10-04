"""Live browser viewport stream (agent-browser WebSocket proxy)."""

from __future__ import annotations

import asyncio
import logging
import threading
import time

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import require_thread_visible

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/threads", tags=["browser-stream"])


class _BrowserViewportBody(BaseModel):
    width: int = Field(ge=320, le=3840)
    height: int = Field(ge=320, le=2160)


class _BrowserClickBody(BaseModel):
    """Click on the live viewport at viewport-CSS-pixel coordinates."""

    x: float = Field(ge=0)
    y: float = Field(ge=0)
    button: str = Field(default="left")
    double_click: bool = Field(default=False)



class _BrowserScrollBody(BaseModel):
    """Scroll the live viewport by wheel deltas (CSS px)."""

    delta_x: float = Field(default=0)
    delta_y: float = Field(default=0)


def _dispatch_browser_command(thread_id: str, command: dict[str, object]) -> dict[str, object]:
    """Synchronously dispatch a browser command via the in-process engine."""
    from evoflow.tools.builtins.browser_engine import (
        browser_engine_enabled,
        get_browser_engine,
    )

    if not browser_engine_enabled():
        raise HTTPException(status_code=503, detail="browser engine disabled")
    engine = get_browser_engine()
    return engine.execute(thread_id, command, timeout=20.0)

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


@router.post(
    "/{thread_id}/browser-viewport",
    summary="Resize the live browser viewport (CSS px, agent + user share the same page)",
)
async def set_browser_viewport_route(
    request: Request, thread_id: str, body: _BrowserViewportBody
) -> dict[str, object]:
    require_thread_visible(request, thread_id)
    logger.info(
        "browser_viewport_set thread=%s width=%s height=%s",
        thread_id,
        body.width,
        body.height,
    )
    result = await asyncio.to_thread(
        _dispatch_browser_command,
        thread_id,
        {"method": "viewportSet", "width": body.width, "height": body.height},
    )
    if not result.get("ok"):
        err = result.get("error") or {}
        logger.warning(
            "browser_viewport_set FAILED thread=%s code=%s msg=%s",
            thread_id,
            err.get("code"),
            err.get("message"),
        )
        raise HTTPException(
            status_code=409 if err.get("code") == "capability_unsupported" else 500,
            detail=err.get("message") or "viewport set failed",
        )
    state = result.get("state") or {}
    logger.info("browser_viewport_set OK thread=%s vw=%s vh=%s", thread_id, state.get("viewportWidth"), state.get("viewportHeight"))
    return {"thread_id": thread_id, "ok": True, "state": state}


@router.post(
    "/{thread_id}/browser-viewport/reset",
    summary="Reset the live browser viewport to default 1280x720",
)
async def reset_browser_viewport_route(request: Request, thread_id: str) -> dict[str, object]:
    require_thread_visible(request, thread_id)
    from evoflow.tools.builtins.browser_contract import DEFAULT_AGENT_BROWSER_VIEWPORT

    result = await asyncio.to_thread(
        _dispatch_browser_command,
        thread_id,
        {
            "method": "viewportSet",
            "width": DEFAULT_AGENT_BROWSER_VIEWPORT["width"],
            "height": DEFAULT_AGENT_BROWSER_VIEWPORT["height"],
        },
    )
    if not result.get("ok"):
        err = result.get("error") or {}
        raise HTTPException(
            status_code=409 if err.get("code") == "capability_unsupported" else 500,
            detail=err.get("message") or "viewport reset failed",
        )
    state = result.get("state") or {}
    return {"thread_id": thread_id, "ok": True, "state": state}


@router.post(
    "/{thread_id}/browser-click",
    summary="Click the live browser at (x, y) viewport CSS pixels",
)
async def click_browser_route(
    request: Request, thread_id: str, body: _BrowserClickBody
) -> dict[str, object]:
    require_thread_visible(request, thread_id)
    button = body.button if body.button in ("left", "right", "middle") else "left"
    logger.info(
        "browser_click thread=%s x=%.1f y=%.1f button=%s dbl=%s",
        thread_id,
        body.x,
        body.y,
        button,
        body.double_click,
    )
    result = await asyncio.to_thread(
        _dispatch_browser_command,
        thread_id,
        {
            "method": "click",
            "x": float(body.x),
            "y": float(body.y),
            "button": button,
            "doubleClick": body.double_click,
        },
    )
    if not result.get("ok"):
        err = result.get("error") or {}
        logger.warning(
            "browser_click FAILED thread=%s code=%s msg=%s",
            thread_id,
            err.get("code"),
            err.get("message"),
        )
        raise HTTPException(
            status_code=500,
            detail=err.get("message") or "click failed",
        )
    state = result.get("state") or {}
    element = result.get("element") or {}
    el_name = element.get("name") or element.get("text") or ""
    logger.info(
        "browser_click OK thread=%s landed=%s url=%s",
        thread_id,
        el_name[:40],
        state.get("url", "")[:80],
    )
    return {"thread_id": thread_id, "ok": True, "state": state, "element": element}


@router.post(
    "/{thread_id}/browser-scroll",
    summary="Scroll the live browser by wheel deltas (CSS px)",
)
async def scroll_browser_route(
    request: Request, thread_id: str, body: _BrowserScrollBody
) -> dict[str, object]:
    require_thread_visible(request, thread_id)
    dx = float(body.delta_x)
    dy = float(body.delta_y)
    if abs(dx) < 1 and abs(dy) < 1:
        return {"thread_id": thread_id, "ok": True}
    # 主轴判定：|dx| 占优走横向，否则纵向；量取主轴绝对值并限幅
    direction = "down" if dy > 0 else "up"
    if abs(dx) > abs(dy):
        direction = "right" if dx > 0 else "left"
    amount = int(min(3000, max(1, round(max(abs(dx), abs(dy))))))
    logger.info("browser_scroll thread=%s direction=%s amount=%d", thread_id, direction, amount)
    result = await asyncio.to_thread(
        _dispatch_browser_command,
        thread_id,
        {"method": "scroll", "direction": direction, "amount": amount},
    )
    if not result.get("ok"):
        err = result.get("error") or {}
        raise HTTPException(status_code=500, detail=err.get("message") or "scroll failed")
    return {"thread_id": thread_id, "ok": True}


class _BrowserCommandBody(BaseModel):
    """Navigation commands from the EvoPanel toolbar (whitelisted methods only)."""

    method: Literal["navigate", "back", "forward"]
    url: str = Field(default="")


@router.post(
    "/{thread_id}/browser-command",
    summary="Navigate / back / forward on the live browser (toolbar whitelist)",
)
async def browser_command_route(
    request: Request, thread_id: str, body: _BrowserCommandBody
) -> dict[str, object]:
    require_thread_visible(request, thread_id)
    command: dict[str, object] = {"method": body.method}
    if body.method == "navigate":
        url = body.url.strip()
        if not (url.startswith("http://") or url.startswith("https://")):
            url = "https://" + url
        try:
            from urllib.parse import urlparse

            if not urlparse(url).hostname:
                raise ValueError(url)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"invalid url: {url}") from exc
        command["url"] = url
    logger.info("browser_command thread=%s method=%s", thread_id, body.method)
    result = await asyncio.to_thread(_dispatch_browser_command, thread_id, command)
    if not result.get("ok"):
        err = result.get("error") or {}
        raise HTTPException(status_code=500, detail=err.get("message") or f"{body.method} failed")
    state = result.get("state") or {}
    return {"thread_id": thread_id, "ok": True, "state": state}


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
