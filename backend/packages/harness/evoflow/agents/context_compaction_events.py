"""Stream custom events so the UI can show context compaction status."""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)


def _emit(event_type: str, *, thread_id: str = "") -> None:
    payload = {"type": event_type}
    if _try_stream_writer(payload):
        return
    _inject_compaction_stream_event(thread_id, event_type)


def _inject_compaction_stream_event(thread_id: str, event_type: str) -> None:
    """Fallback when ``get_stream_writer`` is unavailable (e.g. sync compress pool thread)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return
    if event_type == "context_compaction_start":
        inject: dict[str, Any] = {
            "type": "activity",
            "kind": "compacting",
            "detail": _COMPACTION_ACTIVITY_DETAIL,
        }
    elif event_type == "context_compaction_end":
        inject = {
            "type": "activity",
            "kind": "pre_model",
            "detail": "准备中…",
        }
    else:
        return
    try:
        from app.gateway.streaming.session_stream_inject import schedule_inject_evf_frame
        from app.gateway.streaming.stream_middle_layer import middle_layer_covers_thread

        if middle_layer_covers_thread(tid):
            schedule_inject_evf_frame(tid, inject)
    except Exception:
        logger.debug("compaction stream inject failed thread=%s event=%s", tid, event_type, exc_info=True)


def _try_stream_writer(payload: dict[str, Any]) -> bool:
    try:
        from langgraph.config import get_stream_writer

        writer = get_stream_writer()
    except Exception:
        return False
    if not writer:
        return False
    try:
        writer(payload)
        return True
    except Exception:
        logger.debug("context compaction stream_writer failed", exc_info=True)
        return False


_COMPACTION_ACTIVITY_DETAIL = "正在压缩上下文…"


def emit_compaction_start(*, thread_id: str = "") -> None:
    tid = str(thread_id or "").strip()
    _emit("context_compaction_start", thread_id=tid)
    if tid:
        try:
            from evoflow.observability.agent_activity_stream import emit_agent_activity

            emit_agent_activity(
                tid,
                kind="compacting",
                detail=_COMPACTION_ACTIVITY_DETAIL,
                force=True,
            )
        except Exception:
            logger.debug("compaction start agent_activity failed", exc_info=True)
    try:
        from evoflow.observability.compaction_file_log import log_compaction_trace

        log_compaction_trace(
            "开始压缩",
            thread_id=tid,
            should_trigger=True,
            ui_activity=_COMPACTION_ACTIVITY_DETAIL,
        )
    except Exception:
        logger.debug("compaction trace log failed (start)", exc_info=True)


def emit_compaction_end(*, thread_id: str = "") -> None:
    tid = str(thread_id or "").strip()
    _emit("context_compaction_end", thread_id=tid)
    if tid:
        try:
            from evoflow.observability.agent_activity_stream import emit_agent_activity

            emit_agent_activity(tid, kind="pre_model", detail="准备中…", force=True)
        except Exception:
            logger.debug("compaction end agent_activity failed", exc_info=True)
    try:
        from evoflow.observability.compaction_file_log import log_compaction_trace

        log_compaction_trace(
            "压缩结束",
            thread_id=tid,
            ui_activity="准备中…",
        )
    except Exception:
        logger.debug("compaction trace log failed (end)", exc_info=True)


def _resolve_thread_id_for_stream(*, thread_id: str = "", session_key: str = "") -> str:
    tid = str(thread_id or "").strip()
    if tid:
        return tid
    sk = str(session_key or "").strip()
    if not sk:
        return ""
    try:
        from evoflow.persistence.session_repositories import get_session_row_for_ui

        row = get_session_row_for_ui(sk) or {}
        return str(row.get("thread_id") or "").strip()
    except Exception:
        return ""


async def _http_inject_evf_frame(thread_id: str, payload: dict[str, Any]) -> None:
    secret = (os.getenv("INTERNAL_EVENTS_SECRET") or "").strip()
    if not secret:
        return
    base = (os.getenv("EVOFLOW_GATEWAY_URL") or "http://127.0.0.1:8001").rstrip("/")
    url = f"{base}/api/events/internal/inject-evf"
    try:
        import httpx

        async with httpx.AsyncClient(timeout=3.0) as client:
            await client.post(
                url,
                json={"thread_id": thread_id, "payload": payload},
                headers={"X-Internal-Events-Secret": secret},
            )
    except Exception:
        logger.debug("context_usage http inject failed thread=%s", thread_id, exc_info=True)


def _inject_evf_frame_cross_thread(thread_id: str, payload: dict[str, Any]) -> None:
    """Inject ``evf`` frames from compress pool threads or when stream writer is unavailable."""
    tid = str(thread_id or "").strip()
    if not tid or not isinstance(payload, dict):
        return
    used_direct = False
    try:
        from app.gateway.streaming.session_stream_inject import schedule_inject_evf_frame
        from app.gateway.streaming.stream_middle_layer import middle_layer_covers_thread

        if middle_layer_covers_thread(tid):
            schedule_inject_evf_frame(tid, payload)
            used_direct = True
    except Exception:
        logger.debug("context_usage direct inject failed thread=%s", tid, exc_info=True)

    if used_direct:
        return

    async def _go() -> None:
        await _http_inject_evf_frame(tid, payload)

    # Never schedule httpx on the LangGraph job loop (starves ready→metadata).
    try:
        from evoflow.subagents.detached_poll_scheduler import schedule_detached_poll

        schedule_detached_poll(_go(), name="context_usage_inject")
    except Exception:
        logger.debug("context_usage inject schedule failed thread=%s", tid, exc_info=True)


def emit_context_usage(
    *,
    used_tokens: int,
    window_tokens: int,
    message_count: int,
    before_tokens: int | None = None,
    compacted: bool = False,
    note: str = "",
    session_key: str | None = None,
    thread_id: str | None = None,
    system_tokens: int | None = None,
    tools_tokens: int | None = None,
    message_tokens: int | None = None,
    tool_count: int | None = None,
    api_active_tokens: int | None = None,
) -> None:
    """Push model-bound context fill + composition breakdown to the UI.

    Composition (DeepSeek-style ``contextBreakdown``):
    system prompt / tool schemas / conversation messages — each measured on
    the backend, not inferred by the client.
    """
    from evoflow.persistence.session_context_usage import (
        build_context_usage_snapshot,
        persist_session_context_usage,
    )

    # Prefer explicit args; fall back to gate overhead from the current model bind.
    sys_tok = system_tokens
    tools_tok = tools_tokens
    msg_tok = message_tokens
    tools_n = tool_count
    if sys_tok is None or tools_tok is None or tools_n is None:
        try:
            from evoflow.context.model_request_token_estimate import current_gate_overhead_meta

            meta = current_gate_overhead_meta() or {}
            if sys_tok is None and "system_tokens" in meta:
                sys_tok = int(meta["system_tokens"])
            if tools_tok is None and "tools_tokens" in meta:
                tools_tok = int(meta["tools_tokens"])
            if tools_n is None and "tool_count" in meta:
                tools_n = int(meta["tool_count"])
        except Exception:
            pass

    snapshot = build_context_usage_snapshot(
        used_tokens=used_tokens,
        window_tokens=window_tokens,
        message_count=message_count,
        before_tokens=before_tokens,
        compacted=compacted,
        note=note,
        system_tokens=sys_tok,
        tools_tokens=tools_tok,
        message_tokens=msg_tok,
        tool_count=tools_n,
        api_active_tokens=api_active_tokens,
    )
    payload: dict[str, Any] = {
        "type": "context_usage",
        **snapshot,
    }
    if not _try_stream_writer(payload):
        tid = _resolve_thread_id_for_stream(
            thread_id=str(thread_id or ""),
            session_key=str(session_key or ""),
        )
        if tid:
            _inject_evf_frame_cross_thread(tid, payload)
    sk = str(session_key or "").strip()
    if sk:
        persist_session_context_usage(sk, snapshot)
