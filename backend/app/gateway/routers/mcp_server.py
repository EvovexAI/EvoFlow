"""FastAPI router exposing the MCP Server endpoint at ``/mcp``.

Wires the transport-agnostic JSON-RPC engine in
:mod:`evoflow.mcp.server` to HTTP, implementing the MCP Streamable-HTTP
transport (https://spec.modelcontextprotocol.io/):

* ``POST /mcp`` — receives a JSON-RPC 2.0 request (or batch). When the client
  sends ``Accept: text/event-stream`` the response is delivered as an SSE
  stream (one event per JSON-RPC response); otherwise a single JSON object is
  returned. All requests are authenticated via ``verify_bearer_token``.
* ``GET /mcp`` — opens a long-lived SSE connection (optional long-connection
  mode). The server emits a heartbeat ``endpoint`` event pointing back at
  ``POST /mcp`` so the client knows where to send requests.

The caller context is built from the verified token and marked ``remote=True``
so capabilities are gated on the Remote surface.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse, StreamingResponse

from evoflow.capability import CallerCtx
from evoflow.mcp.server import handle_mcp_batch, handle_mcp_request
from evoflow.persistence.auth_repositories import token_repository

logger = logging.getLogger(__name__)

router = APIRouter(tags=["mcp-server"])

# Scheme prefix expected on the Authorization header.
_BEARER_PREFIX = "Bearer "
# SSE content type for the Streamable-HTTP transport.
_SSE_CONTENT_TYPE = "text/event-stream"


def _verify_bearer_token(authorization: Optional[str]) -> dict[str, Any]:
    """Validate the ``Authorization: Bearer <token>`` header.

    Mirrors :func:`app.gateway.auth.verify_bearer_token`: extracts the bearer
    token, verifies it via :meth:`TokenRepository.verify_token`, and returns the
    caller's identity record. Raises ``401 Unauthorized`` when the header is
    missing, malformed, or the token is unknown / revoked.

    This local copy keeps the router self-contained (the shared auth dependency
    lives in a sibling package whose import path is environment-dependent).

    Args:
        authorization: Raw value of the ``Authorization`` header.

    Returns:
        A dict with ``identity_type``, ``identity_id``, ``token_name`` and
        ``token_hash`` describing the authenticated caller.

    Raises:
        HTTPException: 401 when authentication fails.
    """
    if not authorization or not authorization.startswith(_BEARER_PREFIX):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header; expected 'Bearer <token>'.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    plaintext = authorization[len(_BEARER_PREFIX):].strip()
    if not plaintext:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Empty bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    record = token_repository.verify_token(plaintext)
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or revoked token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if str(record.get("identity_type") or "") == "app":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="App API keys cannot access /mcp; use POST /v1/chat/completions.",
        )

    return {
        "identity_type": str(record["identity_type"]),
        "identity_id": str(record["identity_id"]),
        "token_name": str(record["name"]),
        "token_hash": str(record["token_hash"]),
    }


def _build_caller_ctx(token_data: dict[str, Any]) -> CallerCtx:
    """Build a Remote-surface :class:`CallerCtx` from a verified token.

    MCP clients always arrive through the remote front door, so ``remote=True``
    is forced (yielding :attr:`Surface.Remote` regardless of other fields).

    Args:
        token_data: The identity dict returned by :func:`_verify_bearer_token`.

    Returns:
        A :class:`CallerCtx` with ``remote=True`` and the caller's identity.
    """
    return CallerCtx(
        remote=True,
        user_id=str(token_data.get("identity_id", "")),
    )


def _wants_sse(accept: Optional[str]) -> bool:
    """Whether the client requested an SSE response via the ``Accept`` header.

    Args:
        accept: Raw value of the ``Accept`` header (may be ``None``).

    Returns:
        True if ``text/event-stream`` is among the accepted media types.
    """
    if not accept:
        return False
    return any(
        part.strip().lower() == _SSE_CONTENT_TYPE
        for part in accept.split(",")
    )


def _sse_event(data: dict) -> str:
    """Encode a JSON-RPC response as a single SSE ``message`` event.

    Args:
        data: The JSON-RPC response dict.

    Returns:
        The wire-format SSE event string (``event: message\\ndata: <json>\\n\\n``).
    """
    payload = json.dumps(data, ensure_ascii=False, default=str)
    return f"event: message\ndata: {payload}\n\n"


@router.post("/mcp")
async def mcp_post(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    accept: Optional[str] = Header(default=None),
) -> Any:
    """Handle a JSON-RPC 2.0 request over the MCP Streamable-HTTP transport.

    Authenticates the caller via the ``Authorization`` bearer header, parses the
    JSON-RPC request body (single object or batch), routes it through
    :func:`handle_mcp_request` / :func:`handle_mcp_batch`, and returns either a
    single JSON response or an SSE stream depending on the ``Accept`` header.

    Args:
        request: The incoming FastAPI request (body parsed as JSON).
        authorization: The ``Authorization`` header (bearer token).
        accept: The ``Accept`` header (selects JSON vs SSE).

    Returns:
        A :class:`JSONResponse` for non-streaming clients, or a
        :class:`StreamingResponse` emitting SSE ``message`` events for clients
        that requested ``text/event-stream``.

    Raises:
        HTTPException: 401 on authentication failure; 400 on a malformed JSON
        body.
    """
    token_data = _verify_bearer_token(authorization)
    caller_ctx = _build_caller_ctx(token_data)

    # Parse the JSON-RPC body.
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001 — malformed JSON
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid JSON body: {exc}",
        )

    # Batch request (a JSON array).
    if isinstance(body, list):
        responses = handle_mcp_batch(body, caller_ctx)
        if _wants_sse(accept):
            async def _batch_stream() -> Any:
                """Yield one SSE event per non-notification batch response."""
                for resp in responses:
                    yield _sse_event(resp)

            return StreamingResponse(_batch_stream(), media_type=_SSE_CONTENT_TYPE)
        return JSONResponse(content=responses)

    # Single request.
    response = handle_mcp_request(body, caller_ctx)
    if response is None:
        # Notification: no response payload. Return 202 Accepted with empty body.
        return JSONResponse(content={}, status_code=status.HTTP_202_ACCEPTED)

    if _wants_sse(accept):
        async def _single_stream() -> Any:
            """Yield the single JSON-RPC response as one SSE event."""
            yield _sse_event(response)

        return StreamingResponse(_single_stream(), media_type=_SSE_CONTENT_TYPE)
    return JSONResponse(content=response)


@router.get("/mcp")
async def mcp_get(
    authorization: Optional[str] = Header(default=None),
) -> StreamingResponse:
    """Open a long-lived SSE connection (optional MCP long-connection mode).

    Authenticates the caller, then holds the connection open emitting an initial
    ``endpoint`` event advertising ``POST /mcp`` as the request target, followed
    by periodic heartbeat comments to keep proxies from closing the idle
    connection. This satisfies clients that prefer a persistent SSE channel.

    Args:
        authorization: The ``Authorization`` header (bearer token).

    Returns:
        A :class:`StreamingResponse` with ``Content-Type: text/event-stream``.

    Raises:
        HTTPException: 401 on authentication failure.
    """
    _verify_bearer_token(authorization)

    async def _sse_lifecycle() -> Any:
        """Emit the endpoint announcement then heartbeats."""
        # Per the Streamable-HTTP spec, the server MAY send an `endpoint` event
        # telling the client where to POST subsequent requests.
        yield "event: endpoint\ndata: /mcp\n\n"
        # Heartbeat loop keeps the connection alive; clients ignore comments.
        import asyncio

        while True:
            await asyncio.sleep(15)
            yield ": heartbeat\n\n"

    return StreamingResponse(_sse_lifecycle(), media_type=_SSE_CONTENT_TYPE)


__all__ = ["router"]
