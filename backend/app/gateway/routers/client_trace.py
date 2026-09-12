"""Client-side timing trace endpoints (SSE latency measurement).

These endpoints receive timing data from the frontend to measure
end-to-end SSE latency. Lives at /api/trace/* (NOT under /api/langgraph)
because the LangGraph mount catches all /api/langgraph/* paths.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Request
from starlette.responses import JSONResponse

router = APIRouter(prefix="/api/trace", tags=["client-trace"])

# Re-use existing trace helpers from langgraph_proxy
from app.gateway.routers.langgraph_proxy import (  # noqa: E402
    _append_first_token_trace,
    _trace_gateway_first_token_ts_ms,
)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


@router.post("/first-token-client", include_in_schema=False)
async def trace_first_token_client(request: Request) -> JSONResponse:
    """Receive page_first_token timing from the frontend."""
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"ok": False, "error": "invalid json"})
    if not isinstance(payload, dict):
        return JSONResponse(status_code=400, content={"ok": False, "error": "invalid payload"})

    trace_id = str(payload.get("trace_id") or "").strip()
    thread_id = str(payload.get("thread_id") or "").strip()
    path = str(payload.get("path") or "").strip()
    user_input_ts_ms = payload.get("user_input_ts_ms")
    gateway_first_token_ts_ms = payload.get("gateway_first_token_ts_ms")
    page_first_token_ts_ms = payload.get("page_first_token_ts_ms")
    try:
        user_input_ts_ms = int(user_input_ts_ms) if user_input_ts_ms is not None else None
    except Exception:
        user_input_ts_ms = None
    try:
        gateway_first_token_ts_ms = int(gateway_first_token_ts_ms) if gateway_first_token_ts_ms is not None else None
    except Exception:
        gateway_first_token_ts_ms = None
    if gateway_first_token_ts_ms is None and trace_id:
        gateway_first_token_ts_ms = _trace_gateway_first_token_ts_ms.get(trace_id)
    try:
        page_first_token_ts_ms = int(page_first_token_ts_ms) if page_first_token_ts_ms is not None else None
    except Exception:
        page_first_token_ts_ms = None

    _append_first_token_trace(
        {
            "type": "page_first_token",
            "trace_id": trace_id,
            "thread_id": thread_id or None,
            "path": path or None,
            "user_input_ts_ms": user_input_ts_ms,
            "gateway_first_token_ts_ms": gateway_first_token_ts_ms,
            "page_first_token_ts_ms": page_first_token_ts_ms,
            "page_first_token_at": _now_iso(),
            "latency_input_to_gateway_ms": (gateway_first_token_ts_ms - user_input_ts_ms if isinstance(gateway_first_token_ts_ms, int) and isinstance(user_input_ts_ms, int) else None),
            "latency_gateway_to_page_ms": (page_first_token_ts_ms - gateway_first_token_ts_ms if isinstance(page_first_token_ts_ms, int) and isinstance(gateway_first_token_ts_ms, int) else None),
            "latency_input_to_page_ms": (page_first_token_ts_ms - user_input_ts_ms if isinstance(page_first_token_ts_ms, int) and isinstance(user_input_ts_ms, int) else None),
        }
    )
    return JSONResponse(content={"ok": True})


@router.post("/stream-end-client", include_in_schema=False)
async def trace_stream_end_client(request: Request) -> JSONResponse:
    """Receive page_stream_end timing from the frontend."""
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"ok": False, "error": "invalid json"})
    if not isinstance(payload, dict):
        return JSONResponse(status_code=400, content={"ok": False, "error": "invalid payload"})

    trace_id = str(payload.get("trace_id") or "").strip()
    thread_id = str(payload.get("thread_id") or "").strip()
    user_input_ts_ms = payload.get("user_input_ts_ms")
    page_stream_end_ms = payload.get("page_stream_end_ms")
    duration_ms = payload.get("duration_ms")
    try:
        user_input_ts_ms = int(user_input_ts_ms) if user_input_ts_ms is not None else None
    except Exception:
        user_input_ts_ms = None
    try:
        page_stream_end_ms = int(page_stream_end_ms) if page_stream_end_ms is not None else None
    except Exception:
        page_stream_end_ms = None
    try:
        duration_ms = int(duration_ms) if duration_ms is not None else None
    except Exception:
        duration_ms = None

    _append_first_token_trace(
        {
            "type": "page_stream_end",
            "trace_id": trace_id,
            "thread_id": thread_id or None,
            "user_input_ts_ms": user_input_ts_ms,
            "page_stream_end_ms": page_stream_end_ms,
            "duration_ms": duration_ms,
            "page_stream_end_at": _now_iso(),
        }
    )
    return JSONResponse(content={"ok": True})


@router.post("/tool-approval-client", include_in_schema=False)
async def trace_tool_approval_client(request: Request) -> JSONResponse:
    """接收前端工具授权追踪事件，写入 ``logs/tool-approval-trace.log``。"""
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"ok": False, "error": "invalid json"})
    if not isinstance(payload, dict):
        return JSONResponse(status_code=400, content={"ok": False, "error": "invalid payload"})
    try:
        from evoflow.agents.tool_approval_trace_log import log_tool_approval_trace

        event = str(payload.get("event") or payload.get("事件") or "前端事件").strip()
        _reserved = {
            "event",
            "事件",
            "side",
            "thread_id",
            "threadId",
            "session_key",
            "sessionKey",
            "tool_name",
            "toolName",
            "tool_call_id",
            "toolCallId",
            "run_id",
            "runId",
            "level",
        }
        fields = {k: v for k, v in payload.items() if k not in _reserved}
        log_tool_approval_trace(
            event,
            side="前端",
            thread_id=str(payload.get("thread_id") or payload.get("threadId") or "").strip(),
            session_key=str(payload.get("session_key") or payload.get("sessionKey") or "").strip(),
            tool_name=str(payload.get("tool_name") or payload.get("toolName") or "").strip(),
            tool_call_id=str(payload.get("tool_call_id") or payload.get("toolCallId") or "").strip(),
            run_id=str(payload.get("run_id") or payload.get("runId") or "").strip(),
            **fields,
        )
    except Exception:
        return JSONResponse(status_code=500, content={"ok": False, "error": "trace write failed"})
    return JSONResponse(content={"ok": True})
