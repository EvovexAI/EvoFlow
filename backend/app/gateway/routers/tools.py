"""REST ``/v1`` adapter — the human/script-facing projection of the capability bus.

A FastAPI port of ``nomifun-tauri/crates/backend/nomifun-public/src/rest.rs``.
It is auto-generated from the SAME :class:`evoflow.capability.CapabilityRegistry`
as the MCP adapter, so it inherits every capability and the Remote-surface
gate (Destructive → ``needs_confirmation`` / 409, Sensitive → ``denied``).

Endpoints (all bearer-token gated):

* ``GET  /v1/tools``                   — list Remote-surface capabilities + schemas
* ``GET  /v1/tools?profile=agent|full`` — ``agent`` returns a curated do-work subset
* ``POST /v1/tools/{name}``            — invoke a capability (body = its JSON args)
* ``POST /v1/tools/{name}/stream``     — SSE stream of a capability call
* ``GET  /v1/openapi.json``            — OpenAPI 3.1 doc generated from the schemas

The dispatch result envelope is mapped onto HTTP status codes exactly like the
Rust adapter: ``error`` → 422, ``needs_confirmation`` → 409, otherwise 200.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, AsyncIterator, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.concurrency import run_in_threadpool
from sse_starlette.sse import EventSourceResponse

# --- Auth dependency --------------------------------------------------------
# ``verify_bearer_token`` lives in the gateway auth module. The harness package
# ships it under ``app.gateway.auth``; when this router is mounted in the main
# gateway (whose ``app`` package is ``backend/app``) the harness copy is reached
# via the ``evoflow`` source path. We try the canonical import first and fall
# back to a path-qualified import so the router works in both layouts.
try:  # pragma: no cover - import shim, exercised at runtime
    from app.gateway.auth import verify_capability_bearer_token  # type: ignore
except ImportError:  # pragma: no cover
    import sys

    _HARNESS_ROOT = os.path.join(
        os.path.dirname(__file__), "..", "..", "..", "packages", "harness"
    )
    _HARNESS_ROOT = os.path.abspath(_HARNESS_ROOT)
    if _HARNESS_ROOT not in sys.path:
        sys.path.insert(0, _HARNESS_ROOT)
    # The harness ``app`` package is shadowed by the main ``backend/app`` package
    # once the interpreter has resolved ``app``; load the auth module directly
    # from its file to avoid the package-name collision. Registering it in
    # ``sys.modules`` before exec is required so ``@dataclass`` (used inside
    # auth.py) can resolve the module namespace via ``sys.modules``.
    import importlib.util

    _AUTH_PATH = os.path.join(_HARNESS_ROOT, "app", "gateway", "auth.py")
    _spec = importlib.util.spec_from_file_location(
        "harness_app_gateway_auth", _AUTH_PATH
    )
    _auth_mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
    assert _spec and _spec.loader
    sys.modules["harness_app_gateway_auth"] = _auth_mod
    _spec.loader.exec_module(_auth_mod)
    verify_capability_bearer_token = _auth_mod.verify_capability_bearer_token  # type: ignore[attr-defined]

from evoflow.capability import (
    CallerCtx,
    CapabilityRegistry,
    Surface,
    get_registry,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/v1",
    tags=["capability-bus"],
    # Every endpoint requires a non-app bearer token (app keys use chat/completions).
    dependencies=[Depends(verify_capability_bearer_token)],
)

# Domains advertised under ``?profile=agent`` (the curated do-work subset).
# Mirrors nomifun's ``AGENT_PROFILE_DOMAINS``; overridable via env var so
# deployments can curate their own agent-facing catalog without code changes.
_AGENT_PROFILE_DOMAINS: list[str] = [
    d.strip()
    for d in os.getenv(
        "CAPABILITY_AGENT_PROFILE_DOMAINS",
        "agent,files,search,shell,workspace",
    ).split(",")
    if d.strip()
]


def _registry() -> CapabilityRegistry:
    """Return the process-wide capability registry singleton."""
    return get_registry()


def _specs_for_profile(profile: str | None) -> list:
    """Resolve a profile name to the matching Remote-surface tool specs.

    ``profile=agent`` returns the curated do-work subset (filtered by
    :data:`_AGENT_PROFILE_DOMAINS`); any other value (including the default
    ``full`` / ``None``) returns the full Remote-surface catalog.
    """
    specs = _registry().tool_specs(Surface.Remote)
    if profile == "agent":
        allowed = set(_AGENT_PROFILE_DOMAINS)
        return [s for s in specs if s.domain in allowed]
    return specs


def _spec_names(specs: list) -> set[str]:
    """Extract the set of capability names from a list of tool specs."""
    return {s.name for s in specs}


def _caller_ctx(token_data: dict[str, Any]) -> CallerCtx:
    """Build a Remote-surface :class:`CallerCtx` from a verified token.

    The REST front door always presents the Remote surface so the danger gate
    (Destructive → confirm, Sensitive → deny) applies identically to the MCP
    adapter. ``user_id`` is taken from the token identity when available.
    """
    user_id = str(token_data.get("identity_id") or token_data.get("token_name") or "")
    return CallerCtx(remote=True, user_id=user_id)


def _status_for_result(result: dict[str, Any]) -> int:
    """Map a registry dispatch envelope onto an HTTP status code.

    Mirrors the Rust adapter: ``error`` → 422, ``needs_confirmation`` → 409,
    otherwise 200.
    """
    if "error" in result:
        return status.HTTP_422_UNPROCESSABLE_ENTITY
    if "needs_confirmation" in result:
        return status.HTTP_409_CONFLICT
    return status.HTTP_200_OK


@router.get("/tools", summary="List Remote-surface capabilities")
async def list_tools(
    profile: Optional[str] = Query(
        default=None,
        description="Catalog profile: ``agent`` (curated do-work subset) or ``full`` (default).",
    ),
    token_data: dict[str, Any] = Depends(verify_capability_bearer_token),
) -> dict[str, Any]:
    """List the Remote-surface capability catalog (name + description + schema).

    Each entry mirrors the MCP ``tools/list`` descriptor. ``?profile=agent``
    returns the curated do-work subset (filtered by the configured agent
    profile domains); the default is the full Remote-surface catalog.

    Returns:
        ``{"count": <int>, "tools": [{name, domain, description, input_schema}]}``
    """
    specs = await run_in_threadpool(_specs_for_profile, profile)
    tools = [
        {
            "name": s.name,
            "domain": s.domain,
            "description": s.description,
            "input_schema": s.input_schema,
        }
        for s in specs
    ]
    return {"count": len(tools), "tools": tools}


@router.post(
    "/tools/{name}",
    summary="Invoke a capability",
    status_code=status.HTTP_200_OK,
)
async def call_tool(
    name: str,
    request: Request,
    profile: str | None = Query(default=None),
    token_data: dict[str, Any] = Depends(verify_capability_bearer_token),
) -> Any:
    """Invoke a capability by name. The body is the capability's JSON args.

    Dispatches under the Remote surface, so the danger gate applies:
    Destructive → ``409 needs_confirmation`` (re-call with ``confirm=true``),
    Sensitive → ``422 denied``. A body of ``null`` or empty is treated as ``{}``.

    Status codes mirror the Rust adapter:

    * ``200`` — the handler result envelope.
    * ``409`` — ``needs_confirmation`` (re-call with ``confirm=true``).
    * ``422`` — the tool returned an ``error`` (or is outside the REST scope).
    * ``404`` — unknown tool name.
    """
    # Lenient body parsing: a no-arg tool may be POSTed with an empty body.
    try:
        body = await request.json()
    except Exception:
        body = {}
    args: dict[str, Any] = {} if body is None or not isinstance(body, dict) else body

    # Scope check: the tool must be visible on the Remote surface for this profile.
    visible = _spec_names(await run_in_threadpool(_specs_for_profile, profile))
    if name not in visible:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": f"Tool '{name}' is outside the configured Remote REST capability scope"
            },
        )

    ctx = _caller_ctx(token_data)
    result = await run_in_threadpool(_registry().dispatch, name, args, ctx)
    if asyncio.iscoroutine(result):
        result = await result

    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": f"Unknown tool: {name}"},
        )

    code = _status_for_result(result)
    if code != status.HTTP_200_OK:
        raise HTTPException(status_code=code, detail=result)
    return result


async def _stream_events(
    name: str,
    args: dict[str, Any],
    ctx: CallerCtx,
    visible: set[str],
) -> AsyncIterator[dict[str, str]]:
    """Yield SSE ``data`` frames for a streaming capability call.

    Streams incremental ``{"type": ..}`` deltas as they are produced by the
    capability's streaming handler, then a single terminal
    ``{"type": "__result__", "data": <final>}`` frame. Non-streaming tools emit
    only the terminal frame. A scope violation or unknown tool yields a terminal
    frame carrying the error envelope (so the client always sees a result).
    """
    # ``queue`` carries either a delta value (any JSON-serializable) or the
    # ``_DONE`` sentinel marking the producer has finished and the final result
    # is about to be enqueued.
    queue: asyncio.Queue[Any] = asyncio.Queue()
    result_holder: dict[str, Any] = {}

    def _sink(value: Any) -> None:
        """Progress sink bridging the sync streaming handler to the async queue."""
        try:
            queue.put_nowait(value)
        except Exception:  # pragma: no cover - defensive
            logger.warning("capability stream sink failed for %s", name)

    async def _run() -> None:
        """Execute the (synchronous) streaming dispatch in a worker thread."""
        try:
            if name not in visible:
                final: Any = {
                    "error": f"Tool '{name}' is outside the configured Remote REST capability scope"
                }
            else:
                final = await run_in_threadpool(
                    _registry().dispatch_stream, name, args, ctx, _sink
                )
                if final is None:
                    final = {"error": f"Unknown tool: {name}"}
        except Exception as e:  # pragma: no cover - defensive
            logger.exception("capability stream dispatch failed for %s", name)
            final = {"error": f"stream dispatch failed: {e}"}
        result_holder["final"] = final
        await queue.put(_DONE)

    task = asyncio.create_task(_run())
    try:
        while True:
            item = await queue.get()
            if item is _DONE:
                break
            # Each delta is serialized as a JSON ``data:`` frame.
            yield {"data": json.dumps(item, ensure_ascii=False, default=str)}
        # Terminal frame carries the final result envelope.
        yield {
            "data": json.dumps(
                {"type": "__result__", "data": result_holder.get("final")},
                ensure_ascii=False,
                default=str,
            )
        }
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


# Sentinel marking the producer task has finished enqueuing all deltas.
_DONE: Any = object()


@router.post(
    "/tools/{name}/stream",
    summary="Stream a capability call via Server-Sent Events",
)
async def stream_tool(
    name: str,
    request: Request,
    profile: Optional[str] = Query(default=None),
    token_data: dict[str, Any] = Depends(verify_capability_bearer_token),
) -> EventSourceResponse:
    """Server-Sent Events stream of a capability call.

    Each SSE ``data:`` frame is a JSON event. Streaming tools emit incremental
    ``{"type": ..}`` deltas as they happen, and every call ends with one
    ``{"type": "__result__", "data": <final>}`` frame. Non-streaming tools emit
    only that terminal frame. A scope violation or unknown tool yields a
    terminal frame carrying the error envelope.
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    args: dict[str, Any] = {} if body is None or not isinstance(body, dict) else body

    visible = _spec_names(await run_in_threadpool(_specs_for_profile, profile))
    ctx = _caller_ctx(token_data)

    return EventSourceResponse(
        _stream_events(name, args, ctx, visible),
        media_type="text/event-stream",
        ping=15,
    )


@router.get("/openapi.json", summary="OpenAPI 3.1 spec for the Remote capability API")
async def openapi_spec(
    profile: Optional[str] = Query(default=None),
    token_data: dict[str, Any] = Depends(verify_capability_bearer_token),
) -> dict[str, Any]:
    """Generate an OpenAPI 3.1 document from the registry.

    One ``POST /v1/tools/{name}`` operation is emitted per Remote-surface
    capability, with ``requestBody.schema`` = the capability's input schema and
    a ``bearerAuth`` security scheme applied to every operation.
    """
    specs = await run_in_threadpool(_specs_for_profile, profile)

    paths: dict[str, Any] = {}
    for s in specs:
        paths[f"/v1/tools/{s.name}"] = {
            "post": {
                "summary": s.description,
                "operationId": s.name,
                "requestBody": {
                    "required": True,
                    "content": {
                        "application/json": {"schema": s.input_schema},
                    },
                },
                "responses": {
                    "200": {
                        "description": "tool result",
                        "content": {
                            "application/json": {
                                "schema": {"type": "object"},
                            },
                        },
                    },
                    "409": {
                        "description": "needs confirmation (re-call with confirm=true)"
                    },
                    "422": {"description": "tool returned an error"},
                },
                "security": [{"bearerAuth": []}],
            }
        }

    return {
        "openapi": "3.1.0",
        "info": {
            "title": "Haze-Ctrl Remote Capability API",
            "version": "v1",
            "description": (
                "External access to EvoFlow platform capabilities. All "
                "operations require Authorization: Bearer <access token>."
            ),
        },
        "paths": paths,
        "components": {
            "securitySchemes": {
                "bearerAuth": {"type": "http", "scheme": "bearer"},
            }
        },
    }
