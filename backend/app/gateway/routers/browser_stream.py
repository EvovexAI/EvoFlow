"""Browser routes: panel live-view interactions + legacy stream status stubs.

ZCode parity: the live view is the panel's embedded WebView2 itself — there is
no separate screencast service. The panel's user-driven interactions (address
bar, viewport, click/scroll on the page) dispatch through the same engine the
agent uses, so the user and the agent always share one page. The old
``browser-stream`` screencast routes remain only so older panel builds degrade
gracefully; they report the stream as unavailable instead of pretending a
screencast exists.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException, Request, WebSocket
from fastapi.responses import Response
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import require_thread_visible

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/threads", tags=["browser-stream"])

_NO_STREAM_DETAIL = (
    "Browser live streaming is not part of the engine anymore — the live view "
    "is the EvoPanel embedded browser itself."
)


def _dispatch_browser_command(thread_id: str, command: dict[str, object]) -> dict[str, object]:
    """Synchronously dispatch a browser command via the in-process engine."""
    from evoflow.tools.builtins.browser_engine import (
        browser_engine_enabled,
        get_browser_engine,
    )

    if not browser_engine_enabled():
        raise HTTPException(status_code=503, detail="browser engine disabled")
    engine = get_browser_engine()
    method = str(command.get("method") or "")

    try:
        return engine.execute(thread_id, command, timeout=20.0)
    except TimeoutError:
        logger.warning(
            "browser_engine.execute TIMEOUT thread=%s method=%s",
            thread_id,
            method,
        )
        return {
            "ok": False,
            "error": {
                "code": "TIMEOUT",
                "message": f"browser command '{method}' timed out after 20s — "
                "the WebView2 tab may be stuck; try reloading or opening a new tab",
            },
        }


def _browser_route_payload(
    thread_id: str,
    result: dict[str, object],
    extra: dict[str, object] | None = None,
) -> dict[str, object]:
    """Build the standard response body for browser command/tab endpoints.

    Includes ``stream_ws`` and ``page_url`` so the EvoPanel can bind the live
    view after a user-initiated navigation or tab action.
    """
    from evoflow.tools.builtins.browser_stream import browser_live_ws_path

    state = result.get("state") or {}
    payload: dict[str, object] = {
        "thread_id": thread_id,
        "ok": True,
        "state": state if isinstance(state, dict) else {},
        "stream_ws": browser_live_ws_path(thread_id),
        "page_url": str(state.get("url") or "") if isinstance(state, dict) else "",
        "page_title": str(state.get("title") or "") if isinstance(state, dict) else "",
    }
    if extra:
        for key, value in extra.items():
            payload[key] = value
    return payload


# ---------------------------------------------------------------------------
# Live-view interactions (panel) — dispatched through the same engine as the agent
# ---------------------------------------------------------------------------


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


class _BrowserTabIndexBody(BaseModel):
    index: int = Field(ge=0, le=64)


class _BrowserTabNewBody(BaseModel):
    url: str = Field(default="")


@router.post(
    "/{thread_id}/browser-tabs/list",
    summary="List live browser tabs (url/title/active)",
)
async def browser_tabs_list_route(request: Request, thread_id: str) -> dict[str, object]:
    require_thread_visible(request, thread_id)
    result = await asyncio.to_thread(_dispatch_browser_command, thread_id, {"method": "tabList"})
    if not result.get("ok"):
        err = result.get("error") or {}
        logger.warning(
            "browser_tabs_list FAILED thread=%s code=%s msg=%s",
            thread_id,
            err.get("code"),
            err.get("message"),
        )
        raise HTTPException(status_code=500, detail=err.get("message") or "tabList failed")
    tabs = result.get("tabs") or []
    logger.info(
        "browser_tabs_list OK thread=%s count=%s",
        thread_id,
        len(tabs) if isinstance(tabs, list) else "?",
    )
    return {"thread_id": thread_id, "ok": True, "tabs": tabs}


@router.post(
    "/{thread_id}/browser-tabs/select",
    summary="Switch the active browser tab",
)
async def browser_tabs_select_route(
    request: Request, thread_id: str, body: _BrowserTabIndexBody
) -> dict[str, object]:
    require_thread_visible(request, thread_id)
    result = await asyncio.to_thread(
        _dispatch_browser_command, thread_id, {"method": "tabSelect", "index": body.index}
    )
    if not result.get("ok"):
        err = result.get("error") or {}
        raise HTTPException(status_code=500, detail=err.get("message") or "tabSelect failed")
    return _browser_route_payload(thread_id, result)


@router.post(
    "/{thread_id}/browser-tabs/new",
    summary="Open a new browser tab (optionally navigating to url)",
)
async def browser_tabs_new_route(
    request: Request, thread_id: str, body: _BrowserTabNewBody
) -> dict[str, object]:
    require_thread_visible(request, thread_id)
    result = await asyncio.to_thread(
        _dispatch_browser_command, thread_id, {"method": "tabNew", "url": body.url}
    )
    if not result.get("ok"):
        err = result.get("error") or {}
        raise HTTPException(status_code=500, detail=err.get("message") or "tabNew failed")
    return _browser_route_payload(thread_id, result)


@router.post(
    "/{thread_id}/browser-tabs/close",
    summary="Close a browser tab by index",
)
async def browser_tabs_close_route(
    request: Request, thread_id: str, body: _BrowserTabIndexBody
) -> dict[str, object]:
    require_thread_visible(request, thread_id)
    result = await asyncio.to_thread(
        _dispatch_browser_command, thread_id, {"method": "tabClose", "index": body.index}
    )
    if not result.get("ok"):
        err = result.get("error") or {}
        raise HTTPException(status_code=500, detail=err.get("message") or "tabClose failed")
    return _browser_route_payload(thread_id, result)


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
    # Direct wheel deltas (ZCode CUA parity) — no direction quantization.
    logger.info("browser_scroll thread=%s dx=%.1f dy=%.1f", thread_id, dx, dy)
    result = await asyncio.to_thread(
        _dispatch_browser_command,
        thread_id,
        {"method": "scroll", "scrollX": dx, "scrollY": dy},
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

    # Panel toolbar: first check if the embedded WebView2 has a registered CDP URL.
    # If so, route directly through the Rust HTTP broker instead of the Playwright
    # engine — the WebView2 is owned by the Tauri desktop process, not by Playwright.
    from evoflow.tools.builtins.browser_embed_cdp import get_thread_cdp_url

    embedded_cdp_url = await asyncio.to_thread(get_thread_cdp_url, thread_id)

    if embedded_cdp_url:
        # Extract port from ws://127.0.0.1:PORT/... and call Rust HTTP broker.
        # The HTTP broker is on the same host as the CDP WS broker (same port file).
        import re, httpx

        base_url = await _get_browser_cdp_url()
        if not base_url:
            raise HTTPException(status_code=503, detail="CDP HTTP broker not running")

        cdp_method = {
            "navigate": "Page.navigate",
            "back": "Page.goBack",
            "forward": "Page.goForward",
        }.get(body.method, body.method)

        if body.method == "navigate":
            raw_url = body.url.strip()
            if not raw_url:
                raise HTTPException(status_code=400, detail="navigate requires a URL")
            if not raw_url.startswith(("http://", "https://")):
                raw_url = "https://" + raw_url
            from urllib.parse import urlparse
            if not urlparse(raw_url).hostname:
                raise HTTPException(status_code=400, detail=f"invalid url: {raw_url}")
            params_json = asyncio.to_thread(
                lambda: json.dumps({"url": raw_url})
            )
        else:
            params_json = asyncio.to_thread(lambda: json.dumps({}))

        params_str = await params_json
        url = f"{base_url}/browser-cdp/command?thread_id={thread_id}&method={cdp_method}"
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            resp = await client.post(url, content=params_str)
        if resp.status_code != 200:
            logger.warning(
                "browser_command embedded HTTP %s thread=%s method=%s: %s",
                resp.status_code, thread_id, body.method, resp.text[:200],
            )
            raise HTTPException(status_code=502, detail=f"CDP HTTP error: {resp.text[:200]}")
        data = resp.json()
        if data.get("error"):
            raise HTTPException(status_code=500, detail=str(data["error"]))

        # Synthesize a minimal response so _browser_route_payload can feed the panel.
        result = {
            "ok": True,
            "state": {
                "url": body.url.strip() if body.method == "navigate" else "",
                "title": "",
            },
        }
        return _browser_route_payload(thread_id, result)

    # No embedded CDP: fall back to the Playwright engine.
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
    return _browser_route_payload(thread_id, result)


# ---------------------------------------------------------------------------
# Legacy screencast routes — honest "removed" answers (panel degrades gracefully)
# ---------------------------------------------------------------------------


@router.get(
    "/{thread_id}/browser-stream/status",
    summary="Get browser live stream status (streaming removed — always unavailable)",
)
async def get_browser_stream_status(request: Request, thread_id: str) -> dict[str, object]:
    require_thread_visible(request, thread_id)
    raise HTTPException(status_code=404, detail=_NO_STREAM_DETAIL)


@router.post(
    "/{thread_id}/browser-stream/restart",
    summary="Restart browser live screencast (streaming removed — always unavailable)",
)
async def restart_browser_stream_route(request: Request, thread_id: str) -> dict[str, object]:
    require_thread_visible(request, thread_id)
    raise HTTPException(status_code=404, detail=_NO_STREAM_DETAIL)


@router.websocket("/{thread_id}/browser-stream")
async def browser_stream_ws(websocket: WebSocket, thread_id: str) -> None:
    try:
        require_thread_visible(websocket, thread_id)  # type: ignore[arg-type]
    except HTTPException:
        await websocket.close(code=1008, reason="forbidden")
        return
    # Fail fast with the honest status instead of retrying an upstream that
    # no longer exists (the panel's native embed is the live view).
    await websocket.accept()
    await websocket.send_json({"type": "status", "screencasting": False, "reason": "removed"})
    await websocket.send_json({"type": "error", "message": _NO_STREAM_DETAIL})
    await websocket.close(code=1000)
    logger.info("browser stream ws rejected (streaming removed) thread=%s", thread_id)


@router.get(
    "/{thread_id}/browser-live-frame",
    summary="Deprecated — polling disabled to avoid blocking Gateway",
    deprecated=True,
)
async def get_browser_live_frame(request: Request, thread_id: str) -> Response:
    require_thread_visible(request, thread_id)
    return Response(
        status_code=410,
        content="browser-live-frame polling is disabled; use tool screenshots.",
        media_type="text/plain",
    )


# ---------------------------------------------------------------------------
# Browser CDP via Rust (EvoPanel WebView2)
# ---------------------------------------------------------------------------
# The agent path is browser_engine → the Rust HTTP bridge (browser_cdp_server.rs).
# These routes expose the same bridge to authenticated callers and feed the
# panel's embed status queries.

_PORT_FILE_LOCK = threading.Lock()
_CACHED_PORT: dict[str, int] = {}


def _read_browser_cdp_port() -> int | None:
    """Read the CDP HTTP server port from the well-known file.

    Resolves the EvoFlow home dir the same way the engine does (EVOFLOW_CONFIG_DIR
    and the debug-build ~/.evoflow-dev variant), not a hardcoded ~/.evoflow.
    """
    from evoflow.tools.builtins.browser_engine import _resolve_evoflow_dir

    port_file = os.path.join(_resolve_evoflow_dir(), "browser-cdp-http-port")
    try:
        with open(port_file) as f:
            return int(f.read().strip())
    except (FileNotFoundError, ValueError):
        return None


async def _get_browser_cdp_url() -> str:
    """Get or discover the CDP HTTP server base URL."""
    with _PORT_FILE_LOCK:
        cached = _CACHED_PORT.get("cdp")
        if cached:
            return f"http://127.0.0.1:{cached}"

    port = await asyncio.to_thread(_read_browser_cdp_port)
    if port:
        with _PORT_FILE_LOCK:
            _CACHED_PORT["cdp"] = port
        return f"http://127.0.0.1:{port}"
    return ""


class _EmbedCommandBody(BaseModel):
    """CDP command forwarded to the Rust WebView2 handler."""

    method: str
    params_json: str = "{}"


class _EmbedCommandResponse(BaseModel):
    ok: bool = True
    result: dict[str, object] | None = None
    error: str | None = None


@router.post(
    "/{thread_id}/browser-embed/command",
    summary="Send a CDP command to the EvoPanel embedded browser (Rust WebView2)",
)
async def browser_embed_command(
    request: Request,
    thread_id: str,
    body: _EmbedCommandBody,
) -> _EmbedCommandResponse:
    """Forward a CDP method call to the Rust WebView2 CDP handler via HTTP.

    Direct CDP access to the user's embedded WebView2 — the same
    architecture as ZCode's Electron `<webview>` + `debugger.attach()` pipeline.
    """
    require_thread_visible(request, thread_id)

    base_url = await _get_browser_cdp_url()
    if not base_url:
        raise HTTPException(
            status_code=503,
            detail="EvoPanel CDP HTTP server not available (is the browser panel open?)",
        )

    url = f"{base_url}/browser-cdp/command?thread_id={thread_id}&method={body.method}"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            resp = await client.post(url, content=body.params_json)
        if resp.status_code != 200:
            logger.warning(
                "browser_embed_command HTTP %s thread=%s method=%s: %s",
                resp.status_code, thread_id, body.method, resp.text[:200],
            )
            raise HTTPException(status_code=502, detail=f"CDP server error: {resp.text[:200]}")
        return _EmbedCommandResponse.model_validate(resp.json())
    except httpx.RequestError as exc:
        logger.warning("browser_embed_command network error thread=%s method=%s: %s", thread_id, body.method, exc)
        raise HTTPException(status_code=503, detail=f"CDP server unreachable: {exc}") from exc


@router.get(
    "/{thread_id}/browser-embed/status",
    summary="Check if the EvoPanel embedded browser is open and get its current URL",
)
async def browser_embed_status(request: Request, thread_id: str) -> dict[str, object]:
    """Ask the Rust side whether a WebView2 window exists for this thread."""
    require_thread_visible(request, thread_id)

    base_url = await _get_browser_cdp_url()
    if not base_url:
        return {"ok": False, "available": False, "error": "CDP HTTP server not running"}

    url = f"{base_url}/browser-cdp/status?thread_id={thread_id}"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            resp = await client.get(url)
        if resp.status_code == 200:
            data = resp.json()
            return {
                "ok": True,
                "available": True,
                "url": data.get("url", ""),
                "title": data.get("title", ""),
                "readyState": data.get("readyState", ""),
                "label": data.get("label", ""),
            }
        elif resp.status_code == 500 and "not found" in resp.text.lower():
            return {"ok": True, "available": False, "error": "no embedded browser for this thread"}
        else:
            return {"ok": False, "available": False, "error": resp.text[:200]}
    except httpx.RequestError as exc:
        return {"ok": False, "available": False, "error": str(exc)}
