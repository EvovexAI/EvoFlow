"""MCP Server engine: JSON-RPC 2.0 over Streamable-HTTP.

A lightweight, dependency-free implementation of the Model Context Protocol
server side (https://spec.modelcontextprotocol.io/). It speaks JSON-RPC 2.0 and
exposes the capabilities registered in :class:`CapabilityRegistry` to external
MCP clients (常见 Agent 宿主, …) over the Remote surface.

This module is transport-agnostic: :func:`handle_mcp_request` takes a parsed
JSON-RPC request body and a :class:`CallerCtx` and returns the JSON-RPC
response dict. The FastAPI router in ``app.gateway.routers.mcp_server`` wires
it to ``POST /mcp`` (single JSON or SSE stream) and ``GET /mcp`` (SSE long
connection).

Supported methods:

* ``initialize`` — protocol handshake, returns ``{protocolVersion,
  capabilities, serverInfo}``.
* ``tools/list`` — lists the capabilities visible on the Remote surface, in the
  MCP ``[{name, description, inputSchema}]`` shape.
* ``tools/call`` — dispatches ``{name, arguments}`` through
  :meth:`CapabilityRegistry.dispatch`, returning the result as a single text
  content block (JSON-encoded).
* ``notifications/initialized`` — a notification (no ``id``); acknowledged by
  returning ``None`` (no response payload).
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from evoflow.capability import (
    CallerCtx,
    CapabilityRegistry,
    Surface,
    get_registry,
)

logger = logging.getLogger(__name__)

# MCP protocol version this server speaks. Pinned to the 2024-11-05 spec line
# which is what current mainstream clients (常见 Agent 宿主) negotiate.
PROTOCOL_VERSION = "2024-11-05"

# Server identity advertised in the `initialize` result.
SERVER_NAME = "evoflow"
SERVER_VERSION = "0.1.0"

# JSON-RPC error codes (per the JSON-RPC 2.0 spec + MCP conventions).
_PARSE_ERROR = -32700
_INVALID_REQUEST = -32600
_METHOD_NOT_FOUND = -32601
_INVALID_PARAMS = -32602
_INTERNAL_ERROR = -32603


def _jsonrpc_error(req_id: Any, code: int, message: str, data: Any = None) -> dict:
    """Build a JSON-RPC 2.0 error response object.

    Args:
        req_id: The request ``id`` (echoed back; ``None`` for parse errors).
        code: JSON-RPC error code.
        message: Short human-readable error message.
        data: Optional structured error detail.

    Returns:
        A JSON-RPC error response dict ``{"jsonrpc": "2.0", "id": …,
        "error": {"code", "message", "data"?}}``.
    """
    err: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": req_id, "error": err}


def _jsonrpc_result(req_id: Any, result: Any) -> dict:
    """Build a JSON-RPC 2.0 success response object.

    Args:
        req_id: The request ``id`` to echo back.
        result: The result payload.

    Returns:
        ``{"jsonrpc": "2.0", "id": …, "result": …}``.
    """
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _is_notification(request_body: dict) -> bool:
    """Whether a JSON-RPC request is a notification (no ``id``, no response).

    Per the JSON-RPC 2.0 spec, a request without an ``id`` member is a
    notification and MUST NOT be answered.

    Args:
        request_body: The parsed JSON-RPC request.

    Returns:
        True if the request carries no ``id`` member.
    """
    return "id" not in request_body


def _tool_spec_to_mcp(spec) -> dict:
    """Convert a registry :class:`ToolSpec` to the MCP tool descriptor shape.

    The registry emits ``input_schema`` (snake_case); MCP clients expect
    ``inputSchema`` (camelCase). The ``danger``/``domain`` fields are registry
    internals and are dropped from the wire format.

    Args:
        spec: A :class:`ToolSpec` instance.

    Returns:
        ``{"name", "description", "inputSchema"}`` MCP tool descriptor.
    """
    return {
        "name": spec.name,
        "description": spec.description,
        "inputSchema": spec.input_schema,
    }


def _handle_initialize(request_body: dict) -> dict:
    """Answer the ``initialize`` handshake.

    Returns the negotiated protocol version, this server's capabilities (tools
    only — no resources/prompts/logging for now), and server identity.

    Args:
        request_body: The parsed ``initialize`` request.

    Returns:
        A JSON-RPC success response with
        ``{protocolVersion, capabilities, serverInfo}``.
    """
    req_id = request_body.get("id")
    result = {
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {
            "tools": {"listChanged": False},
        },
        "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
    }
    return _jsonrpc_result(req_id, result)


def _handle_tools_list(
    request_body: dict, registry: CapabilityRegistry
) -> dict:
    """Answer ``tools/list`` with the Remote-surface capabilities.

    Only capabilities not hard-denied on the Remote surface are listed (the
    registry's :meth:`tool_specs` already applies that filter).

    Args:
        request_body: The parsed ``tools/list`` request.
        registry: The capability registry to read from.

    Returns:
        A JSON-RPC success response with ``{"tools": [...]}``.
    """
    req_id = request_body.get("id")
    specs = registry.tool_specs(Surface.Remote)
    tools = [_tool_spec_to_mcp(s) for s in specs]
    return _jsonrpc_result(req_id, {"tools": tools})


def _handle_tools_call(
    request_body: dict, registry: CapabilityRegistry, caller_ctx: CallerCtx
) -> dict:
    """Answer ``tools/call`` by dispatching to the registry.

    Parses ``{name, arguments}``, runs the capability through
    :meth:`CapabilityRegistry.dispatch` (which applies the permission gate and
    validates arguments), and wraps the result dict as a single MCP text
    content block. Gate denials / confirmations / validation errors are returned
    as normal text content so the LLM can self-correct, mirroring the registry's
    structured-error contract.

    Args:
        request_body: The parsed ``tools/call`` request.
        registry: The capability registry to dispatch through.
        caller_ctx: The calling-session context (Remote surface).

    Returns:
        A JSON-RPC success response with
        ``{"content": [{"type": "text", "text": ...}], "isError": false}``.
    """
    req_id = request_body.get("id")
    params = request_body.get("params") or {}
    name = params.get("name")
    arguments = params.get("arguments") or {}

    if not isinstance(name, str) or not name:
        return _jsonrpc_error(req_id, _INVALID_PARAMS, "tools/call requires a string 'name'.")

    # Dispatch through the permission gate + validated handler.
    result = registry.dispatch(name, dict(arguments), caller_ctx)
    text = json.dumps(result, ensure_ascii=False, default=str)

    # MCP marks tool errors with isError=true so clients surface them to the
    # LLM rather than treating them as transport failures. A result containing
    # an "error" or "needs_confirmation" key is a logical tool error.
    is_error = isinstance(result, dict) and (
        "error" in result or "needs_confirmation" in result
    )

    return _jsonrpc_result(
        req_id,
        {
            "content": [{"type": "text", "text": text}],
            "isError": is_error,
        },
    )


def handle_mcp_request(
    request_body: dict,
    caller_ctx: CallerCtx,
    registry: Optional[CapabilityRegistry] = None,
) -> Optional[dict]:
    """Unified entry point for a single MCP JSON-RPC 2.0 request.

    Routes the request to the appropriate handler (``initialize``,
    ``tools/list``, ``tools/call``, or the ``notifications/initialized``
    notification), returning the JSON-RPC response dict. Notifications return
    ``None`` (no response should be sent, per the JSON-RPC spec).

    Args:
        request_body: The parsed JSON-RPC 2.0 request object.
        caller_ctx: The calling-session context. For the MCP remote front door
            this is a :class:`CallerCtx` with ``remote=True`` (Remote surface).
        registry: The capability registry to use. Defaults to the process-wide
            singleton from :func:`get_registry`.

    Returns:
        The JSON-RPC response dict, or ``None`` for notifications (which must
        not be answered).
    """
    reg = registry if registry is not None else get_registry()

    # Validate minimal JSON-RPC 2.0 shape.
    if not isinstance(request_body, dict) or request_body.get("jsonrpc") != "2.0":
        return _jsonrpc_error(
            request_body.get("id") if isinstance(request_body, dict) else None,
            _INVALID_REQUEST,
            "Invalid Request: not a JSON-RPC 2.0 object.",
        )

    method = request_body.get("method")
    if not isinstance(method, str):
        return _jsonrpc_error(
            request_body.get("id"),
            _INVALID_REQUEST,
            "Invalid Request: missing or non-string 'method'.",
        )

    # Notifications carry no `id` and must not be answered.
    if _is_notification(request_body):
        # Acknowledge the initialized notification silently; any other
        # notification is also swallowed per spec (no response).
        logger.debug("MCP notification received: %s", method)
        return None

    try:
        if method == "initialize":
            return _handle_initialize(request_body)
        if method == "tools/list":
            return _handle_tools_list(request_body, reg)
        if method == "tools/call":
            return _handle_tools_call(request_body, reg, caller_ctx)
        if method == "ping":
            # MCP ping: empty result keeps the connection alive.
            return _jsonrpc_result(request_body.get("id"), {})
        return _jsonrpc_error(
            request_body.get("id"),
            _METHOD_NOT_FOUND,
            f"Method not found: {method!r}.",
        )
    except Exception as exc:  # noqa: BLE001 — surface as JSON-RPC error
        logger.exception("MCP handler failed for method=%s", method)
        return _jsonrpc_error(
            request_body.get("id"),
            _INTERNAL_ERROR,
            "Internal error.",
            data={"detail": str(exc)},
        )


def handle_mcp_batch(
    request_body: list,
    caller_ctx: CallerCtx,
    registry: Optional[CapabilityRegistry] = None,
) -> list:
    """Handle a JSON-RPC 2.0 batch request (a list of requests).

    Each item is routed through :func:`handle_mcp_request`; notifications
    (returning ``None``) are dropped from the response batch. An empty batch
    returns a single JSON-RPC error per spec.

    Args:
        request_body: The parsed JSON-RPC batch (a list of request objects).
        caller_ctx: The calling-session context.
        registry: The capability registry to use (defaults to singleton).

    Returns:
        A list of JSON-RPC response dicts (one per non-notification request).
    """
    if not isinstance(request_body, list) or len(request_body) == 0:
        return [_jsonrpc_error(None, _INVALID_REQUEST, "Invalid Request: empty batch.")]

    responses: list[dict] = []
    for item in request_body:
        resp = handle_mcp_request(item, caller_ctx, registry)
        if resp is not None:
            responses.append(resp)
    # If the batch was all-notifications, spec says return no response; we
    # return an empty list and the caller decides whether to emit anything.
    return responses


__all__ = [
    "PROTOCOL_VERSION",
    "SERVER_NAME",
    "SERVER_VERSION",
    "handle_mcp_request",
    "handle_mcp_batch",
]
