"""H3-B-4: HTTP/SSE routes for v4 projection writer.

End-points (all under ``/api/v4/sessions``):

- ``POST /api/v4/sessions`` — new session (allocates writer)
- ``GET  /api/v4/sessions/{sid}/snapshot`` — current snapshot frame (JSON)
- ``GET  /api/v4/sessions/{sid}/stream`` — SSE live deltas (H3-B-3 feed from
  langgraph_proxy, or unit-test driven)

The writer is shared with the H1 demo orchestrator via ``writer_registry``
so the two paths can coexist per session in process.

Auth: this router is open in dev (matches the v4 demo convention); in
production it should be guarded by the same session-visibility middleware
as ``/api/chat/sessions/{key}/messages`` (deferred to H3-C).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse

from app.gateway.v4_demo.writer_registry import (
    get_or_create_writer,
    list_sessions as registry_list_sessions,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v4/sessions", tags=["v4-sessions"])

_SSE_HEARTBEAT_INTERVAL_S = 15.0


@router.post("", summary="Allocate a v4 projection session (writer + subscription)")
async def post_v4_session() -> dict[str, Any]:
    """H3-B-4: new session. Returns writer/seq + initial subscription id.

    Subscribers must poll ``/stream`` to receive deltas; on first connect
    the snapshot is replayed as a single ``conversationSnapshot`` event.
    """
    import uuid

    sid = f"v4-{uuid.uuid4().hex[:8]}"
    sub_id = f"sub-{uuid.uuid4().hex[:8]}"
    w = get_or_create_writer(sid)
    seq = w.current_seq()
    return {
        "sessionId": sid,
        "subscriptionId": sub_id,
        "logEpoch": w.log_epoch,
        "seq": seq,
    }


@router.get("/{session_id}/snapshot", summary="Current snapshot frame for a v4 session")
async def get_v4_snapshot(
    session_id: str,
    subscriptionId: str = Query(..., description="Subscription id to attach"),
) -> JSONResponse:
    sid = str(session_id or "").strip()
    if not sid:
        raise HTTPException(status_code=422, detail="session_id required")
    w = get_or_create_writer(sid)
    frame = w.snapshot(subscriptionId)
    return JSONResponse(frame.payload)


@router.get("", summary="List active v4 session ids (diagnostic)")
async def list_v4_sessions() -> dict[str, Any]:
    return {"sessions": registry_list_sessions()}


@router.get("/{session_id}/stream", summary="SSE live deltas for a v4 session")
async def stream_v4_session(
    session_id: str,
    subscriptionId: str = Query(..., description="Subscription id"),
    afterSeq: int | None = Query(None, description="Resume after this seq (excl)"),
) -> StreamingResponse:
    """H3-B-4: SSE feed of v4 conversationDeltas frames.

    On connect:
      1. Sends a single ``conversationSnapshot`` if writer has rows (replay).
      2. Long-polls ``drain_pending`` every ~50ms; emits pending frames.
      3. Heartbeats every ~15s to keep the connection alive.

    H3-B-3 will start calling ``emit_*`` on the same writer from
    ``langgraph_proxy._attach_ui_wire_frame`` so deltas flow automatically.
    """
    sid = str(session_id or "").strip()
    if not sid:
        raise HTTPException(status_code=422, detail="session_id required")
    w = get_or_create_writer(sid)

    async def _gen() -> Any:
        last_seq = int(afterSeq) if afterSeq is not None else -1
        # Drain any frames that arrived before connect (RUN_STARTED onwards).
        pending_pre = w.drain_pending(subscriptionId)
        if pending_pre:
            for f in pending_pre:
                yield f"event: v4.frame\ndata: {json.dumps(f.payload, ensure_ascii=False)}\n\n"
                last_seq = f.to_seq
        elif w.current_seq() > 0 and last_seq < w.current_seq():
            # No pending (writer idle) and we are behind: full snapshot replay.
            snap = w.snapshot(subscriptionId)
            yield f"event: v4.frame\ndata: {json.dumps(snap.payload, ensure_ascii=False)}\n\n"
            last_seq = snap.to_seq

        last_hb = time.monotonic()
        while True:
            await asyncio.sleep(0.05)
            pending = w.drain_pending(subscriptionId)
            for f in pending:
                if f.from_seq <= last_seq:
                    last_seq = max(last_seq, f.to_seq)
                    continue
                yield f"event: v4.frame\ndata: {json.dumps(f.payload, ensure_ascii=False)}\n\n"
                last_seq = f.to_seq
            now = time.monotonic()
            if now - last_hb > _SSE_HEARTBEAT_INTERVAL_S:
                yield ": heartbeat\n\n"
                last_hb = now

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def install_v4_routes(app: Any) -> None:
    """Mount ``router`` on a FastAPI app (H3-B-4 integration point)."""
    if not any(getattr(r, "path", "") == router.prefix for r in app.router.routes):
        app.include_router(router)
