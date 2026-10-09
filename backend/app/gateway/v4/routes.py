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
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse

from app.gateway.v4.conversation import HUB as V4_CONVERSATION_HUB
from app.gateway.v4_demo.writer_registry import (
    get_or_create_writer,
    list_sessions as registry_list_sessions,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v4/sessions", tags=["v4-sessions"])

conversation_router = APIRouter(prefix="/api/v4/conversation", tags=["v4-conversation"])

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
            await asyncio.sleep(0.02)  # 20ms poll interval for smoother streaming
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
    if not any(getattr(r, "path", "") == conversation_router.prefix for r in app.router.routes):
        app.include_router(conversation_router)


# ── V4 conversation（ZCode v4 wire 协议；客户端 = vendored zcode-ui shell）──


def _session_id_from_topic(topic: str) -> str:
    prefix = "conversation/"
    if not topic.startswith(prefix) or len(topic) <= len(prefix):
        raise HTTPException(status_code=422, detail=f"invalid v4 topic: {topic!r}")
    return topic[len(prefix):]


@conversation_router.post("/hello", summary="v4 wire handshake: host hello")
async def v4_conversation_hello(body: dict[str, Any] | None = None) -> JSONResponse:
    """对齐 zcode ``helloConversationV4``：返回 host hello（连接级，clientHello 只注册一次）。"""
    payload = body or {}
    connection_id = str(payload.get("connectionId") or "").strip() or f"conn-{uuid.uuid4().hex[:10]}"
    hello = {
        "kind": "hello",
        "protocolVersion": 3,
        "connectionId": connection_id,
        "clientMode": "desktop-continuous",
        "deliveryProfile": "continuous",
        "serverTime": int(time.time() * 1000),
        "capabilities": {
            "nativeDialogs": True,
            "localTerminal": False,
            "binaryFrames": False,
            "compression": "none",
            "workspaceHookReview": False,
            "independentPlanState": False,
            "workflowRunDeltas": False,
        },
        "auth": {},
    }
    return JSONResponse(hello)


@conversation_router.post("/initialize", summary="v4 wire handshake: clientHello")
async def v4_conversation_initialize(body: dict[str, Any]) -> JSONResponse:
    """对齐 zcode ``initializeConversationV4``：注册 clientId（当前仅回执，不做鉴权）。"""
    if not body.get("clientId"):
        raise HTTPException(status_code=422, detail="clientId is required")
    return JSONResponse({"ok": True})


@conversation_router.post("/subscribe", summary="v4 conversation subscribe (ACK-only)")
async def v4_conversation_subscribe(body: dict[str, Any]) -> JSONResponse:
    """对齐 zcode ``subscribeConversationV4``：ACK-only；initial snapshot 走 frames SSE。"""
    connection_id = str(body.get("connectionId") or "").strip()
    topic = str(body.get("topic") or "").strip()
    if not connection_id or not topic:
        raise HTTPException(status_code=422, detail="connectionId and topic are required")
    session_id = _session_id_from_topic(topic)
    base = body.get("base") if isinstance(body.get("base"), dict) else None
    result = await V4_CONVERSATION_HUB.subscribe(
        connection_id=connection_id,
        session_id=session_id,
        base=base,
    )
    return JSONResponse(result)


@conversation_router.post("/unsubscribe", summary="v4 conversation unsubscribe")
async def v4_conversation_unsubscribe(body: dict[str, Any]) -> JSONResponse:
    subscription_id = str(body.get("subscriptionId") or "").strip()
    if not subscription_id:
        raise HTTPException(status_code=422, detail="subscriptionId is required")
    await V4_CONVERSATION_HUB.unsubscribe(subscription_id=subscription_id)
    return JSONResponse({"ok": True})


@conversation_router.post("/command", summary="v4 conversation command -> CommandAck")
async def v4_conversation_command(body: dict[str, Any]) -> JSONResponse:
    envelope = body.get("envelope") if isinstance(body.get("envelope"), dict) else body
    if not envelope.get("commandId") or not envelope.get("type"):
        raise HTTPException(status_code=422, detail="commandId and type are required")
    ack = await V4_CONVERSATION_HUB.send_command(envelope)
    return JSONResponse(ack)


@conversation_router.post("/resync", summary="v4 conversation resync (same-sub recovery)")
async def v4_conversation_resync(body: dict[str, Any]) -> JSONResponse:
    """对齐 zcode ``resyncConversationV4``：重投完整 snapshot（recovery deliveryKind）。"""
    subscription_id = str(body.get("subscriptionId") or "").strip()
    if not subscription_id:
        raise HTTPException(status_code=422, detail="subscriptionId is required")
    base = body.get("base") if isinstance(body.get("base"), dict) else None
    try:
        result = await V4_CONVERSATION_HUB.resync(subscription_id=subscription_id, base=base)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"unknown subscription {subscription_id}")
    return JSONResponse(result)


@conversation_router.post("/rows_range", summary="v4 conversation rows range query")
async def v4_conversation_rows_range(body: dict[str, Any]) -> JSONResponse:
    """对齐 zcode ``conversationRowsRangeV4``：按游标向上取一窗历史行（升序）。"""
    session_id = str(body.get("sessionId") or "").strip()
    if not session_id:
        raise HTTPException(status_code=422, detail="sessionId is required")
    before_row_id = body.get("beforeRowId")
    limit = int(body.get("limit") or 200)
    try:
        result = V4_CONVERSATION_HUB.rows_range(
            session_id,
            before_row_id=int(before_row_id) if before_row_id is not None else None,
            limit=limit,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail=f"unknown session {session_id}")
    return JSONResponse(result)


@conversation_router.get("/frames", summary="v4 conversation wire frames (SSE)")
async def v4_conversation_frames(
    connectionId: str = Query(..., description="Client connection id"),
) -> StreamingResponse:
    """按 connectionId 下发 ``ConversationTopicWireCandidate``（``event: v4.wire``）。

    首帧为该连接所有订阅的 initial snapshot（subscribe 时入队）；之后为增量 delta 帧。
    """
    connection_id = str(connectionId or "").strip()
    if not connection_id:
        raise HTTPException(status_code=422, detail="connectionId required")

    async def _gen() -> Any:
        last_hb = time.monotonic()
        while True:
            frames = V4_CONVERSATION_HUB.poll_frames(connection_id)
            if frames:
                for f in frames:
                    yield f"event: v4.wire\ndata: {json.dumps(f, ensure_ascii=False)}\n\n"
                # 让出事件循环，turn 协程才有 CPU 写队列（之前裸 continue 会饿死同 loop）。
                await asyncio.sleep(0)
                continue
            await asyncio.sleep(0.008)
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
