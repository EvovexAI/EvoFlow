"""H1 demo FastAPI router。

Endpoints:
  POST /v4/demo/new_session               → { sessionId, subscriptionId }
  POST /v4/demo/send_text                 → { turnId }
  GET  /v4/demo/stream/{session_id}      → SSE: snapshot frame + deltas
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncGenerator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from .orchestrator import ORCHESTRATOR

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v4/demo", tags=["v4-demo"])


@router.post("/new_session")
async def new_session() -> dict[str, str]:
    session_id, subscription_id = await ORCHESTRATOR.new_session()
    return {"sessionId": session_id, "subscriptionId": subscription_id}


@router.post("/send_text")
async def send_text(session_id: str, text: str) -> dict[str, Any]:
    sess = ORCHESTRATOR.get_session(session_id)
    if not sess:
        raise HTTPException(status_code=404, detail=f"unknown session {session_id}")
    return await ORCHESTRATOR.send_text(session_id, text)


@router.get("/snapshot/{session_id}")
async def snapshot(session_id: str) -> dict[str, Any]:
    sess = ORCHESTRATOR.get_session(session_id)
    if not sess:
        raise HTTPException(status_code=404, detail=f"unknown session {session_id}")
    frame = sess.writer.snapshot(sess.subscription_id)
    return frame.model_dump()


@router.get("/stream/{session_id}")
async def stream(session_id: str) -> StreamingResponse:
    """SSE 流：先发 snapshot，再无限循环发送新 deltas。

    Demo 简化：仅当 ``send_text`` 触发 producer 写入新 frame 时才推送；前端
    通过 `event: frame` 接收，每行 frame 是 JSON。
    """
    sess = ORCHESTRATOR.get_session(session_id)
    if not sess:
        raise HTTPException(status_code=404, detail=f"unknown session {session_id}")

    sub = sess.subscription_id

    async def gen() -> AsyncGenerator[str, None]:
        # 1) initial snapshot
        snap = sess.writer.snapshot(sub)
        yield _sse_line("frame", snap.model_dump())
        last_seq = sess.writer.current_seq()
        # 2) drain pending then loop until close
        try:
            while True:
                # drain any new pending frames
                frames = sess.writer.drain_pending(sub)
                for f in frames:
                    yield _sse_line("frame", f.model_dump())
                # wait for new writes via writer's internal pending
                # H1 demo：poll 50ms
                await asyncio.sleep(0.05)
                cur_seq = sess.writer.current_seq()
                if cur_seq > last_seq:
                    last_seq = cur_seq
        except asyncio.CancelledError:
            logger.info("[h1-demo] stream cancelled session=%s", session_id)
            raise

    return StreamingResponse(gen(), media_type="text/event-stream")


def _sse_line(event: str, data: dict[str, Any]) -> str:
    """format ``event: <name>\\ndata: <json>\\n\\n``"""
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event}\ndata: {payload}\n\n"
