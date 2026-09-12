"""Proxy interactive chat turns to Gateway LangGraph SSE and re-emit as RPC notifications."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlencode

import httpx

EmitFn = Callable[[dict[str, Any]], Awaitable[None] | None]

# Reuse one AsyncClient for gateway/call — on Windows, constructing a new
# httpx.AsyncClient per request costs ~300–400ms (vs ~2ms with a warm pool).
_shared_gateway_client: httpx.AsyncClient | None = None
_shared_gateway_client_lock: asyncio.Lock | None = None


def _client_lock() -> asyncio.Lock:
    global _shared_gateway_client_lock
    if _shared_gateway_client_lock is None:
        _shared_gateway_client_lock = asyncio.Lock()
    return _shared_gateway_client_lock


async def _get_shared_gateway_client() -> httpx.AsyncClient:
    global _shared_gateway_client
    client = _shared_gateway_client
    if client is not None and not client.is_closed:
        return client
    async with _client_lock():
        client = _shared_gateway_client
        if client is not None and not client.is_closed:
            return client
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(60.0),
            limits=httpx.Limits(max_connections=40, max_keepalive_connections=20),
        )
        try:
            from evoflow.platform.asyncio_windows import register_httpx_client_for_reset

            register_httpx_client_for_reset(client)
        except Exception:
            pass
        _shared_gateway_client = client
        return client


async def reset_shared_gateway_client_for_tests() -> None:
    """Close shared client (tests / shutdown)."""
    global _shared_gateway_client
    async with _client_lock():
        client = _shared_gateway_client
        _shared_gateway_client = None
        if client is not None and not client.is_closed:
            await client.aclose()


def _auth_headers(authorization: str | None) -> dict[str, str]:
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    token = (authorization or "").strip()
    if token:
        headers["Authorization"] = token if token.lower().startswith("bearer ") else f"Bearer {token}"
    return headers


async def proxy_gateway_call(
    *,
    gateway_base: str,
    method: str,
    path: str,
    body: Any = None,
    query: dict[str, Any] | None = None,
    authorization: str | None = None,
    headers: dict[str, str] | None = None,
    timeout_ms: int | None = None,
) -> dict[str, Any]:
    """One-shot JSON/text Gateway HTTP call for desktop ``gateway/call`` RPC."""
    base = gateway_base.rstrip("/")
    raw_path = str(path or "")
    if not raw_path.startswith("/"):
        raw_path = "/" + raw_path
    url = f"{base}{raw_path}"
    params: list[tuple[str, str]] = []
    if isinstance(query, dict):
        for key, value in query.items():
            if value is None or value == "":
                continue
            if isinstance(value, list):
                for item in value:
                    params.append((str(key), str(item)))
            else:
                params.append((str(key), str(value)))
    req_headers: dict[str, str] = {}
    token = (authorization or "").strip()
    if token:
        req_headers["Authorization"] = token if token.lower().startswith("bearer ") else f"Bearer {token}"
    if headers:
        for key, value in headers.items():
            if value is None:
                continue
            req_headers[str(key)] = str(value)
    method_u = str(method or "GET").upper()
    timeout = httpx.Timeout((timeout_ms or 60_000) / 1000.0)
    client = await _get_shared_gateway_client()
    resp = await client.request(
        method_u,
        url,
        params=params or None,
        json=body if body is not None and method_u not in {"GET", "HEAD"} else None,
        headers=req_headers or None,
        timeout=timeout,
    )
    text = resp.text
    parsed: Any
    try:
        parsed = resp.json()
    except Exception:
        parsed = text
    return {
        "ok": resp.is_success,
        "status": resp.status_code,
        "body": parsed,
        "error": None if resp.is_success else (parsed if isinstance(parsed, str) else None),
    }


def _build_stream_url(gateway_base: str, thread_id: str, query: dict[str, Any] | None) -> str:
    base = gateway_base.rstrip("/")
    path = f"{base}/api/langgraph/threads/{thread_id}/runs/stream"
    q = dict(query or {})
    q.setdefault("ui_sse", "1")
    q.setdefault("stream_format", "agui")
    q.setdefault("cancel_on_disconnect", "false")
    # httpx/urlencode collapses multi stream_mode; Gateway accepts repeated keys via list form
    pairs: list[tuple[str, str]] = []
    for key, value in q.items():
        if key == "stream_mode" and isinstance(value, list):
            for item in value:
                pairs.append((key, str(item)))
        elif value is None:
            continue
        else:
            pairs.append((key, str(value)))
    if "stream_mode" not in q:
        for mode in ("values", "messages-tuple", "custom"):
            pairs.append(("stream_mode", mode))
    return f"{path}?{urlencode(pairs)}"


def _parse_sse_frame(payload: str) -> tuple[str, Any]:
    """Split one SSE frame into (event_name, data). Data is JSON-parsed when possible."""
    event_name = "message"
    data_lines: list[str] = []
    for raw_line in payload.replace("\r\n", "\n").split("\n"):
        line = raw_line
        if line.startswith("event:"):
            event_name = line[6:].strip() or "message"
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    raw = "\n".join(data_lines)
    if not raw:
        return event_name, None
    try:
        return event_name, json.loads(raw)
    except json.JSONDecodeError:
        return event_name, raw


# Fat LangGraph modes — UI with ui_sse/agui ignores these; forwarding them over stdio
# JSON-RPC (often multi-100KB values snapshots) destroys token pacing.
_PIPE_DROP_EVENTS = frozenset({"values", "messages", "messages-tuple", "custom"})


def should_forward_stream_event(event_name: str, query: dict[str, Any] | None = None) -> bool:
    """Whether a parsed SSE event should cross the app-server pipe to the desktop UI."""
    q = query if isinstance(query, dict) else {}
    fmt = str(q.get("stream_format") or "").strip().lower()
    ui_raw = q.get("ui_sse")
    ui = str(ui_raw).strip().lower() in ("1", "true", "yes", "on") if ui_raw is not None else False
    # Default client always sends ui_sse=1&stream_format=agui
    if not ui and fmt not in ("agui", "ag-ui", "openai", "evf"):
        return True
    ev = str(event_name or "message").strip().lower()
    if ev in _PIPE_DROP_EVENTS:
        return False
    return True


async def _emit_stream_event(emit: EmitFn, event_name: str, data: Any) -> None:
    """native-style structured notification (not raw SSE text)."""
    maybe = emit(
        {
            "method": "stream/event",
            "params": {"event": event_name, "data": data},
        }
    )
    if maybe is not None and hasattr(maybe, "__await__"):
        await maybe


async def proxy_turn_stream(
    *,
    gateway_base: str,
    thread_id: str,
    body: dict[str, Any],
    authorization: str | None = None,
    query: dict[str, Any] | None = None,
    extra_headers: dict[str, str] | None = None,
    emit: EmitFn,
    should_abort: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """POST Gateway runs/stream and forward structured ``stream/event`` notifications.

    Returns a small summary for the JSON-RPC result (after the stream completes).
    """
    url = _build_stream_url(gateway_base, thread_id, query)
    headers = _auth_headers(authorization)
    if extra_headers:
        for key, value in extra_headers.items():
            if value is not None and str(value).strip():
                headers[str(key)] = str(value)

    frames = 0
    forwarded = 0
    dropped = 0
    status_code = 0
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream("POST", url, headers=headers, json=body) as resp:
            status_code = resp.status_code
            if resp.status_code >= 400:
                text = (await resp.aread()).decode("utf-8", errors="replace")
                raise RuntimeError(f"Gateway HTTP {resp.status_code}: {text[:800]}")

            buffer = ""
            async for chunk in resp.aiter_text():
                if should_abort and should_abort():
                    await resp.aclose()
                    break
                if not chunk:
                    continue
                buffer += chunk
                while "\n\n" in buffer:
                    frame, buffer = buffer.split("\n\n", 1)
                    payload = frame.strip("\r\n")
                    if not payload:
                        continue
                    frames += 1
                    event_name, data = _parse_sse_frame(payload)
                    if not should_forward_stream_event(event_name, query):
                        dropped += 1
                        continue
                    forwarded += 1
                    await _emit_stream_event(emit, event_name, data)

            if buffer.strip():
                frames += 1
                event_name, data = _parse_sse_frame(buffer.strip("\r\n"))
                if should_forward_stream_event(event_name, query):
                    forwarded += 1
                    await _emit_stream_event(emit, event_name, data)
                else:
                    dropped += 1

    summary = {
        "ok": True,
        "status": status_code,
        "frames": frames,
        "forwarded": forwarded,
        "dropped": dropped,
        "threadId": thread_id,
    }
    maybe = emit({"method": "turn/completed", "params": summary})
    if maybe is not None and hasattr(maybe, "__await__"):
        await maybe
    return summary


async def proxy_sse_stream(
    *,
    gateway_base: str,
    method: str,
    path: str,
    body: Any = None,
    query: dict[str, Any] | None = None,
    authorization: str | None = None,
    extra_headers: dict[str, str] | None = None,
    emit: EmitFn,
    should_abort: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """Proxy an arbitrary Gateway SSE request and re-emit structured ``stream/event``."""
    base = gateway_base.rstrip("/")
    raw_path = str(path or "")
    if not raw_path.startswith("/"):
        raw_path = "/" + raw_path
    url = f"{base}{raw_path}"
    params: list[tuple[str, str]] = []
    if isinstance(query, dict):
        for key, value in query.items():
            if value is None or value == "":
                continue
            if isinstance(value, list):
                for item in value:
                    params.append((str(key), str(item)))
            else:
                params.append((str(key), str(value)))
    headers = _auth_headers(authorization)
    # GET SSE: Accept only; drop JSON content-type unless body is sent
    method_u = str(method or "GET").upper()
    if method_u in {"GET", "HEAD"}:
        headers.pop("Content-Type", None)
    if extra_headers:
        for key, value in extra_headers.items():
            if value is not None and str(value).strip():
                headers[str(key)] = str(value)

    frames = 0
    status_code = 0
    async with httpx.AsyncClient(timeout=None) as client:
        req_kwargs: dict[str, Any] = {"headers": headers, "params": params or None}
        if body is not None and method_u not in {"GET", "HEAD"}:
            req_kwargs["json"] = body
        async with client.stream(method_u, url, **req_kwargs) as resp:
            status_code = resp.status_code
            if resp.status_code >= 400:
                text = (await resp.aread()).decode("utf-8", errors="replace")
                raise RuntimeError(f"Gateway HTTP {resp.status_code}: {text[:800]}")

            buffer = ""
            async for chunk in resp.aiter_text():
                if should_abort and should_abort():
                    await resp.aclose()
                    break
                if not chunk:
                    continue
                buffer += chunk
                while "\n\n" in buffer:
                    frame, buffer = buffer.split("\n\n", 1)
                    payload = frame.strip("\r\n")
                    if not payload:
                        continue
                    frames += 1
                    event_name, data = _parse_sse_frame(payload)
                    await _emit_stream_event(emit, event_name, data)

            if buffer.strip():
                frames += 1
                event_name, data = _parse_sse_frame(buffer.strip("\r\n"))
                await _emit_stream_event(emit, event_name, data)

    summary = {"ok": True, "status": status_code, "frames": frames, "path": raw_path}
    maybe = emit({"method": "turn/completed", "params": summary})
    if maybe is not None and hasattr(maybe, "__await__"):
        await maybe
    return summary


def parse_json_line(line: str) -> dict[str, Any] | None:
    try:
        parsed = json.loads(line)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None
