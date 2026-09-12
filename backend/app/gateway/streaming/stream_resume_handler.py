"""SSE handler for chat stream resume (history poll).

续流服务 **进行中的 AI 回复**：定时查询 ``evoflow_chat_messages`` 最新记录并推送
``historySnapshot``，run 结束后发 ``runCompleted``。不再依赖 mirror 表 catchup/live。
托管状态由 ``GET /api/hosted/by-key`` 轮询，不在此 endpoint multiplex。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections.abc import AsyncIterator
from typing import Any

from evoflow.persistence.session_run_state import (
    is_run_status_active,
)

logger = logging.getLogger(__name__)

RESUME_PHASE_EVENT = "resumePhase"
RESUME_UNAVAILABLE_EVENT = "resumeUnavailable"
RUN_COMPLETED_EVENT = "runCompleted"
HISTORY_SNAPSHOT_EVENT = "historySnapshot"


STREAM_RESUME_TTL_SECONDS = int(os.getenv("EVOFLOW_STREAM_RESUME_TTL_SECONDS", "300") or "300")
# History poll interval while run is still active.
HISTORY_POLL_INTERVAL_MS = int(os.getenv("EVOFLOW_STREAM_RESUME_HISTORY_POLL_MS", "800") or "800")
# Keepalive comment frame when no snapshot change in N seconds (prevents proxy idle close).
LIVE_KEEPALIVE_INTERVAL_S = float(os.getenv("EVOFLOW_STREAM_RESUME_KEEPALIVE_S", "15") or "15")
# Max messages in historySnapshot / runCompleted payloads.
RUN_COMPLETED_MSG_LIMIT = int(os.getenv("EVOFLOW_STREAM_RESUME_MSG_LIMIT", "2000") or "2000")
IDLE_GRACE_TICKS = int(os.getenv("EVOFLOW_STREAM_RESUME_IDLE_GRACE_TICKS", "2") or "2")
STATUS_CHECK_INTERVAL_MS = int(os.getenv("EVOFLOW_STREAM_RESUME_STATUS_CHECK_MS", "1000") or "1000")

# Retained for tests that import legacy finish helpers.
LIVE_POLL_INTERVAL_FAST_MS = int(os.getenv("EVOFLOW_STREAM_RESUME_LIVE_POLL_FAST_MS", "80") or "80")
LIVE_POLL_INTERVAL_IDLE_MS = int(os.getenv("EVOFLOW_STREAM_RESUME_LIVE_POLL_IDLE_MS", "400") or "400")
MIRROR_RECENT_ACTIVITY_MS = int(os.getenv("EVOFLOW_STREAM_RESUME_MIRROR_RECENT_MS", "8000") or "8000")


def _sse_event(event: str, data: str) -> str:
    return f"event: {event}\ndata: {data}\n\n"


def _sse_comment(comment: str) -> str:
    return f": {comment}\n\n"


def _resume_should_finish(*, terminal_seen: bool, run_status: str | None) -> bool:
    """Only close stream-resume when terminal *and* session run is no longer active."""
    if not terminal_seen:
        return False
    st = str(run_status or "").strip().lower()
    return not is_run_status_active(st)


def _history_sig(payload: dict[str, Any]) -> str:
    """Cheap change detector for history poll (count + last message identity/text)."""
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return f"{payload.get('runStatus')}|0"
    n = len(messages)
    if n <= 0:
        return f"{payload.get('runStatus')}|0"
    last = messages[-1] if isinstance(messages[-1], dict) else {}
    mid = str(last.get("id") or last.get("messageId") or last.get("seq") or "")
    role = str(last.get("role") or "")
    content = last.get("content")
    if isinstance(content, str):
        text_len = len(content)
        text_tail = content[-64:] if content else ""
    elif isinstance(content, list):
        text_len = len(content)
        text_tail = str(content[-1])[:64] if content else ""
    else:
        text_len = 0
        text_tail = ""
    return f"{payload.get('runStatus')}|{n}|{mid}|{role}|{text_len}|{text_tail}"


async def _probe_langgraph_active(
    *,
    session_key: str,
    thread_id: str | None,
    run_id: str | None,
) -> bool | None:
    """Return True/False when LangGraph run is active/inactive; None if unreachable."""
    tid = str(thread_id or "").strip() or None
    if not tid:
        return None
    rid = str(run_id or "").strip() or None
    try:
        import httpx

        from app.gateway.run_status_reconcile import discover_active_run_id, is_thread_run_active

        timeout = httpx.Timeout(connect=2.0, read=6.0, write=6.0, pool=8.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            if rid:
                active = await is_thread_run_active(client, tid, run_id=rid)
                if active is True:
                    return True
                thread_active = await is_thread_run_active(client, tid, run_id=None)
                if thread_active is True:
                    return True
                if thread_active is False:
                    return False
                return None
            active = await is_thread_run_active(client, tid, run_id=None)
            if active is True:
                return True
            if active is False:
                discovered = await discover_active_run_id(client, tid)
                return True if discovered else False
            return None
    except Exception:
        logger.debug("stream_resume LangGraph probe failed session=%s", session_key, exc_info=True)
        return None


async def _heal_session_run_active_if_needed(
    *,
    session_key: str,
    thread_id: str | None,
    run_id: str | None,
) -> None:
    """Align SQLite run_status with a LangGraph run that is still active."""
    tid = str(thread_id or "").strip() or None
    if not tid:
        return
    rid = str(run_id or "").strip() or None
    try:
        import httpx

        from app.gateway.run_status_reconcile import ensure_session_run_active

        timeout = httpx.Timeout(connect=2.0, read=6.0, write=6.0, pool=8.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            await ensure_session_run_active(
                client,
                session_key=session_key,
                thread_id=tid,
                run_id=rid,
            )
    except Exception:
        logger.debug("stream_resume heal run_status failed session=%s", session_key, exc_info=True)


async def _resume_should_finish_async(
    session_key: str,
    *,
    thread_id: str | None,
    run_id: str | None,
    terminal_seen: bool,
    run_status: str | None,
) -> bool:
    """Confirm run ended before finishing resume; heal stale DB run_status."""
    if not terminal_seen:
        return False
    active = await _probe_langgraph_active(
        session_key=session_key,
        thread_id=thread_id,
        run_id=run_id,
    )
    if active is True:
        await _heal_session_run_active_if_needed(
            session_key=session_key,
            thread_id=thread_id,
            run_id=run_id,
        )
        return False
    if active is False:
        return True
    return not is_run_status_active(str(run_status or "").strip().lower())


async def _live_idle_should_finish(
    session_key: str,
    *,
    thread_id: str | None,
    run_id: str | None,
) -> bool:
    """After DB reads idle, confirm LangGraph before ending history poll."""
    active = await _probe_langgraph_active(
        session_key=session_key,
        thread_id=thread_id,
        run_id=run_id,
    )
    if active is True:
        await _heal_session_run_active_if_needed(
            session_key=session_key,
            thread_id=thread_id,
            run_id=run_id,
        )
        return False
    if active is False:
        return True
    # LangGraph unreachable — keep polling rather than emit a false runCompleted.
    return False


async def _load_completed_payload(session_key: str) -> dict[str, Any]:
    from evoflow.persistence import chat_message_repositories as msg_repo
    from evoflow.persistence import session_repositories as sess_repo
    from evoflow.persistence.session_run_state import normalize_run_status

    row = sess_repo.get_session_row_for_ui(session_key) or {}
    messages = msg_repo.list_messages_for_display(session_key, limit=RUN_COMPLETED_MSG_LIMIT)
    raw_status = str(row.get("run_status") or row.get("runStatus") or "").strip()
    run_status = normalize_run_status(raw_status)
    return {
        "ok": True,
        "sessionKey": session_key,
        "runStatus": run_status,
        "threadId": row.get("thread_id") or row.get("threadId"),
        "runId": row.get("current_run_id") or row.get("currentRunId"),
        "messages": messages,
        "session": row,
    }


async def _mark_run_ended_before_completed(
    session_key: str,
    thread_id: str | None,
    run_id: str | None,
) -> None:
    """续流确认 run 已终止后，同步 DB run_status→idle。"""
    tid = str(thread_id or "").strip()
    if not tid:
        return
    try:
        from app.gateway.run_status_reconcile import notify_attach_run_terminal

        await notify_attach_run_terminal(tid, run_id=run_id)
    except Exception:
        logger.debug(
            "stream_resume mark_run_ended failed session=%s thread=%s",
            session_key,
            tid,
            exc_info=True,
        )


async def _finish_chat_resume(
    session_key: str,
    *,
    run_completed: dict[str, Any] | None = None,
) -> AsyncIterator[str]:
    """Chat run 续流结束：发 runCompleted + done。"""
    if run_completed:
        yield _sse_event(RUN_COMPLETED_EVENT, json.dumps(run_completed, ensure_ascii=False))
    yield _sse_event("done", "[DONE]")


async def stream_resume_events(
    session_key: str,
    *,
    run_id: str | None = None,
    thread_id: str | None = None,
    after_seq: int | None = None,
) -> AsyncIterator[str]:
    """History-poll resume: push latest DB messages until the run is idle.

    ``after_seq`` is accepted for API compatibility but ignored (no mirror seq).
    """
    del after_seq  # mirror seq watermark retired
    from evoflow.persistence import session_repositories as sess_repo

    sk = str(session_key or "").strip()
    if not sk:
        yield _sse_event("error", json.dumps({"message": "session_key required"}))
        yield _sse_event("done", "[DONE]")
        return

    if sess_repo.is_session_deleted(sk):
        yield _sse_event("error", json.dumps({"message": "session not found"}))
        yield _sse_event("done", "[DONE]")
        return

    row = sess_repo.get_session_row_for_ui(sk) or {}
    run_status = str(row.get("run_status") or row.get("runStatus") or "idle").strip().lower()
    tid = str(thread_id or row.get("thread_id") or row.get("threadId") or "").strip() or None
    requested_rid = str(run_id or "").strip() or None

    from evoflow.observability.poll_loop_log import log_poll_loop_end, log_poll_loop_start, log_poll_tick

    log_poll_loop_start(
        "stream_resume",
        session_key=sk,
        run_id=requested_rid,
        thread_id=tid or None,
    )

    try:
        if not requested_rid:
            if not is_run_status_active(run_status):
                completed = await _load_completed_payload(sk)
                yield _sse_event(RUN_COMPLETED_EVENT, json.dumps(completed, ensure_ascii=False))
            else:
                yield _sse_event(
                    RESUME_UNAVAILABLE_EVENT,
                    json.dumps({"reason": "runIdRequired"}, ensure_ascii=False),
                )
            yield _sse_event("done", "[DONE]")
            return

        rid = requested_rid
        await _heal_session_run_active_if_needed(session_key=sk, thread_id=tid, run_id=rid)

        row = sess_repo.get_session_row_for_ui(sk) or {}
        run_status = str(row.get("run_status") or row.get("runStatus") or "idle").strip().lower()

        if not is_run_status_active(run_status):
            active = await _probe_langgraph_active(session_key=sk, thread_id=tid, run_id=rid)
            if active is not True:
                completed = await _load_completed_payload(sk)
                async for frame in _finish_chat_resume(sk, run_completed=completed):
                    yield frame
                return

        yield _sse_event(RESUME_PHASE_EVENT, "catchup")
        payload = await _load_completed_payload(sk)
        last_sig = _history_sig(payload)
        yield _sse_event(HISTORY_SNAPSHOT_EVENT, json.dumps(payload, ensure_ascii=False))

        yield _sse_event(RESUME_PHASE_EVENT, "live")

        deadline_ms = time.time() * 1000 + STREAM_RESUME_TTL_SECONDS * 1000
        last_keepalive_time = time.time()
        last_status_check_ms = time.time() * 1000
        status_seen_idle = False
        idle_grace_remaining = 0
        poll_ms = max(200, HISTORY_POLL_INTERVAL_MS)
        terminal_seen = False

        while time.time() * 1000 < deadline_ms:
            log_poll_tick("stream_resume_history", key=f"{sk}:{rid}", interval_s=30.0)
            await asyncio.sleep(poll_ms / 1000.0)

            payload = await _load_completed_payload(sk)
            sig = _history_sig(payload)
            now = time.time()
            if sig != last_sig:
                last_sig = sig
                last_keepalive_time = now
                status_seen_idle = False
                idle_grace_remaining = 0
                yield _sse_event(HISTORY_SNAPSHOT_EVENT, json.dumps(payload, ensure_ascii=False))
            elif now - last_keepalive_time >= LIVE_KEEPALIVE_INTERVAL_S:
                yield _sse_comment("keepalive")
                last_keepalive_time = now

            now_ms = now * 1000
            if now_ms - last_status_check_ms < STATUS_CHECK_INTERVAL_MS:
                continue
            last_status_check_ms = now_ms

            row = sess_repo.get_session_row_for_ui(sk) or {}
            st = str(row.get("run_status") or row.get("runStatus") or "").strip().lower()
            if is_run_status_active(st):
                status_seen_idle = False
                idle_grace_remaining = 0
                continue

            if not status_seen_idle:
                status_seen_idle = True
                idle_grace_remaining = IDLE_GRACE_TICKS
                continue
            if idle_grace_remaining > 0:
                idle_grace_remaining -= 1
                continue
            if await _live_idle_should_finish(sk, thread_id=tid, run_id=rid):
                terminal_seen = True
                break
            status_seen_idle = False
            idle_grace_remaining = 0

        if terminal_seen:
            row = sess_repo.get_session_row_for_ui(sk) or {}
            st = str(row.get("run_status") or row.get("runStatus") or "").strip().lower()
            if await _resume_should_finish_async(
                sk,
                thread_id=tid,
                run_id=rid,
                terminal_seen=True,
                run_status=st,
            ):
                await _mark_run_ended_before_completed(sk, tid, rid)
                completed = await _load_completed_payload(sk)
                async for frame in _finish_chat_resume(sk, run_completed=completed):
                    yield frame
                return
            yield _sse_event(
                RESUME_UNAVAILABLE_EVENT,
                json.dumps({"reason": "runStillActive"}, ensure_ascii=False),
            )
            yield _sse_event("done", "[DONE]")
            return

        yield _sse_event(
            RESUME_UNAVAILABLE_EVENT,
            json.dumps({"reason": "liveTtlExceeded"}, ensure_ascii=False),
        )
        yield _sse_event("done", "[DONE]")
    finally:
        log_poll_loop_end("stream_resume", session_key=sk, run_id=requested_rid)
