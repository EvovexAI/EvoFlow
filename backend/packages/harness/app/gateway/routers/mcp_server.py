"""MCP Server HTTP router — exposes ``/mcp`` for external MCP clients.

This router wires the transport-agnostic JSON-RPC 2.0 engine in
:mod:`evoflow.mcp.server` to the FastAPI HTTP layer, implementing the
Streamable-HTTP transport of the Model Context Protocol
(https://spec.modelcontextprotocol.io/).

Endpoints:

* ``POST /mcp`` — receives a JSON-RPC 2.0 request (single object or batch).
  Authenticated via :func:`~app.gateway.auth.verify_bearer_token`. When the
  client sends ``Accept: text/event-stream`` the response is streamed back as
  a Server-Sent Events stream (one ``data:`` event per JSON-RPC response),
  which is what streaming tool calls use; otherwise a single JSON object (or
  JSON array for batches) is returned.
* ``GET /mcp`` — opens an SSE long-connection (endpoint event). Used by clients
  that prefer to keep a server→client stream open and post requests over it;
  here it is a lightweight keep-alive endpoint emitting the ``endpoint`` event.

All requests are dispatched through :func:`evoflow.mcp.server.handle_mcp_request`
with a :class:`evoflow.capability.CallerCtx` built from the verified bearer
token and flagged ``remote=True`` so capabilities are evaluated on the
:attr:`~evoflow.capability.Surface.Remote` permission surface.
"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncGenerator

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse, StreamingResponse

from app.gateway.auth import verify_bearer_token
from evoflow.capability import CallerCtx
from evoflow.mcp.server import handle_mcp_batch, handle_mcp_request

logger = logging.getLogger(__name__)

router = APIRouter(tags=["mcp-server"])

# SSE separator: two newlines terminate one event.
_SSE_EVENT_SEP = "\n\n"


def _build_caller_ctx(token_data: dict[str, Any]) -> CallerCtx:
    """Build a Remote-surface :class:`CallerCtx` from a verified token.

    The bearer token has already been validated by
    :func:`verify_bearer_token`; we only need to translate its identity dict
    into the capability-layer context, flagging ``remote=True`` so the
    permission gate evaluates capabilities on the Remote surface.

    Args:
        token_data: Identity dict returned by ``verify_bearer_token``
            (``identity_type``, ``identity_id``, ``token_name``,
            ``token_hash``).

    Returns:
        A :class:`CallerCtx` with ``remote=True`` and the caller's user id.
    """
    return CallerCtx(
        remote=True,
        user_id=str(token_data.get("identity_id", "")),
    )


def _sse_event(payload: dict | list) -> bytes:
    """Serialize one JSON-RPC response as a single SSE ``data:`` event.

    Args:
        payload: A JSON-RPC response object (or batch list).

    Returns:
        The encoded SSE event bytes (``data: <json>\\n\\n``).
    """
    return f"data: {json.dumps(payload, ensure_ascii=False, default=str)}".encode("utf-8") + _SSE_EVENT_SEP.encode("utf-8")


async def _stream_jsonrpc(
    body: Any, caller_ctx: CallerCtx
) -> AsyncGenerator[bytes, None]:
    """Yield JSON-RPC response(s) as SSE events.

    Handles both single requests (dict) and batches (list). Notifications
    produce no event (``handle_mcp_request`` returns ``None``). The stream
    closes after all responses are emitted.

    Args:
        body: The parsed JSON-RPC request (dict) or batch (list).
        caller_ctx: The Remote-surface caller context.

    Yields:
        Encoded SSE event bytes.
    """
    if isinstance(body, list):
        responses = handle_mcp_batch(body, caller_ctx)
        for resp in responses:
            yield _sse_event(resp)
    else:
        resp = handle_mcp_request(body, caller_ctx)
        if resp is not None:
            yield _sse_event(resp)


@router.post("/mcp")
async def mcp_post(
    request: Request,
    accept: str | None = Header(default=None),
    token_data: dict[str, Any] = Depends(verify_bearer_token),
) -> Any:
    """Handle an MCP JSON-RPC 2.0 request over Streamable-HTTP.

    Parses the request body as a JSON-RPC 2.0 object (or batch list), builds a
    Remote-surface :class:`CallerCtx` from the verified bearer token, and
    dispatches through :func:`handle_mcp_request`.

    Response mode depends on the ``Accept`` header:

    * ``text/event-stream`` (or any SSE-capable Accept) → a
      :class:`StreamingResponse` of SSE ``data:`` events, one per JSON-RPC
      response. This is the path streaming tool calls take.
    * otherwise → a single :class:`JSONResponse` carrying the JSON-RPC response
      object (or array for a batch). Notifications yield ``202 Accepted`` with
      no body (per the JSON-RPC spec, notifications are not answered).

    Args:
        request: The incoming FastAPI request (body is parsed as JSON).
        accept: Value of the ``Accept`` header.
        token_data: Identity dict injected by ``verify_bearer_token``.

    Returns:
        A :class:`StreamingResponse` (SSE) or :class:`JSONResponse`.

    Raises:
        HTTPException: 400 if the body is not valid JSON.
    """
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001 — JSON parse failure → 400
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Request body must be a valid JSON-RPC 2.0 object or batch.",
        ) from exc

    caller_ctx = _build_caller_ctx(token_data)

    # Streamable-HTTP: if the client accepts SSE, stream responses back.
    wants_sse = accept is not None and "text/event-stream" in accept

    if wants_sse:
        return StreamingResponse(
            _stream_jsonrpc(body, caller_ctx),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # Non-streaming: single JSON object / array.
    if isinstance(body, list):
        responses = handle_mcp_batch(body, caller_ctx)
        # All-notifications batch → no content to return.
        if not responses:
            return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content=None)
        return JSONResponse(content=responses)

    resp = handle_mcp_request(body, caller_ctx)
    if resp is None:
        # Notification: must not be answered.
        return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content=None)
    return JSONResponse(content=resp)


@router.get("/mcp")
async def mcp_get(
    token_data: dict[str, Any] = Depends(verify_bearer_token),
) -> StreamingResponse:
    """Open an SSE long-connection for the MCP Streamable-HTTP transport.

    Emits an ``endpoint`` event announcing the POST endpoint (per the
    Streamable-HTTP transport), then keeps the connection open with periodic
    keep-alive comments. Clients that prefer a persistent server→client stream
    can hold this open; requests are still sent to ``POST /mcp``.

    Authenticated via :func:`verify_bearer_token` so only holders of a valid
    token can open a stream.

    Args:
        token_data: Identity dict injected by ``verify_bearer_token``.

    Returns:
        A :class:`StreamingResponse` with ``media_type="text/event-stream"``.
    """

    async def event_stream() -> AsyncGenerator[bytes, None]:
        """Yield the endpoint announcement then keep-alive comments."""
        endpoint_event = (
            "event: endpoint\n"
            f"data: {json.dumps('/mcp')}\n\n"
        )
        yield endpoint_event.encode("utf-8")
        # Keep the connection alive with periodic comments (SSE comment lines
        # start with ':'). A short cadence is enough to defeat proxies that
        # close idle connections.
        import asyncio

        while True:
            await asyncio.sleep(15)
            yield b": keep-alive\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


__all__ = ["router"]
