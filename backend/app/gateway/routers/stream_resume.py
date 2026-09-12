"""Stream resume SSE endpoint for chat sessions."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from evoflow.authz.http_guard import require_session_visible
from fastapi.responses import StreamingResponse

from app.gateway.streaming.stream_resume_handler import stream_resume_events

router = APIRouter(prefix="/api/chat/sessions", tags=["chat-stream-resume"])


def _wants_sse(request: Request) -> bool:
    """Accept SSE-friendly requests.

    Most fetch()/Tauri WebView calls send ``Accept: */*`` or no Accept header.
    Treat those as acceptable so the panel does not get a confusing ``406`` —
    the response body is always SSE-formatted anyway.
    """
    accept = (request.headers.get("accept") or "").lower().strip()
    if not accept:
        return True
    if "text/event-stream" in accept:
        return True
    if "*/*" in accept:
        return True
    return False


@router.get("/{session_key:path}/stream-resume", summary="Resume in-progress chat via history poll")
async def get_stream_resume(
    session_key: str,
    request: Request,
    runId: str | None = Query(None, alias="runId"),
    threadId: str | None = Query(None, alias="threadId"),
    afterSeq: int | None = Query(None, alias="afterSeq", description="断点续查：从该 seq 之后开始回放，跳过已读帧"),
):
    key = session_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="session_key required")
    require_session_visible(request, key)

    if not _wants_sse(request):
        raise HTTPException(
            status_code=406,
            detail="Accept: text/event-stream or */* required for stream resume",
        )

    async def _gen():
        async for chunk in stream_resume_events(key, run_id=runId, thread_id=threadId, after_seq=afterSeq):
            yield chunk

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
