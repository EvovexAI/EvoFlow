"""Session execution commands — unified stop / idle transitions."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.session_run_state import peek_current_run_id
from evoflow.session_execution.langgraph_cancel import (
    cancel_langgraph_runs_before_send,
    sweep_langgraph_runs_until_idle,
)
from evoflow.session_execution.types import SessionStopResult

logger = logging.getLogger(__name__)


def _unregister_stream_proxy(thread_id: str | None) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    try:
        from app.gateway.routers.langgraph_proxy import unregister_active_stream_proxy

        unregister_active_stream_proxy(tid)
    except Exception:
        logger.debug("unregister stream proxy on stop failed thread=%s", tid, exc_info=True)


def _resolve_thread_id(session_key: str, row: dict[str, Any] | None) -> str | None:
    data = row or {}
    tid = str(data.get("thread_id") or data.get("threadId") or "").strip()
    return tid or None


def _clear_live_snapshot(session_key: str, thread_id: str | None) -> None:
    try:
        from app.gateway.streaming.live_run_snapshot import clear_gateway_live_snapshot

        clear_gateway_live_snapshot(thread_id, session_key=session_key)
    except Exception:
        logger.debug("clear live snapshot failed session=%s", session_key, exc_info=True)


def _reset_collab_on_stop(thread_id: str) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    try:
        from evoflow.agents.tool_approval_service import cancel_all_pending_approvals

        cancel_all_pending_approvals(tid)
    except Exception:
        logger.debug("cancel pending tool approvals failed thread=%s", tid, exc_info=True)
    try:
        from evoflow.collab.models import CollabPhase
        from evoflow.collab.thread_collab import (
            load_thread_collab_state,
            merge_thread_collab_state,
            save_thread_collab_state,
        )
        from evoflow.runtime.paths import get_paths

        paths = get_paths()
        current = load_thread_collab_state(paths, tid)
        merged = merge_thread_collab_state(current, {"collab_phase": CollabPhase.IDLE.value})
        save_thread_collab_state(paths, tid, merged)
    except Exception:
        logger.debug("reset collab phase on stop failed thread=%s", tid, exc_info=True)


async def mark_session_idle(session_key: str, *, reason: str = "user_stop") -> SessionStopResult:
    """Force terminal run_status + partial mirror persist (legacy run-idle semantics)."""
    from evoflow.session_execution.lifecycle import end_session_turn
    from evoflow.persistence.session_run_state import derive_execution_phase

    key = str(session_key or "").strip()
    if not key:
        raise ValueError("session_key required")
    row_before = sess_repo.get_session_row_for_ui(key) or {}
    tid = _resolve_thread_id(key, row_before)
    run_id = peek_current_run_id(session_key=key) or str(row_before.get("currentRunId") or row_before.get("current_run_id") or "").strip() or None

    await end_session_turn(session_key=key, thread_id=tid, force=True, reason=reason)
    _clear_live_snapshot(key, tid)

    row = sess_repo.get_session_row_for_ui(key)
    raw = str((row or {}).get("runStatus") or (row or {}).get("run_status") or "").strip().lower()
    phase = derive_execution_phase(raw)
    return SessionStopResult(
        ok=True,
        session_key=key,
        run_id=run_id,
        phase=phase,
        cancelled_run_ids=[],
        session=row,
    )


async def stop_session_execution(
    session_key: str,
    *,
    user_initiated: bool = True,
    reason: str | None = None,
) -> SessionStopResult:
    """User stop: cancel LangGraph runs, terminal DB status, persist partial, reset collab."""
    key = str(session_key or "").strip()
    if not key:
        raise ValueError("session_key required")
    if sess_repo.is_session_deleted(key):
        raise ValueError("session not found")

    stop_reason = str(reason or ("user_stop" if user_initiated else "send_prep")).strip() or "user_stop"

    row_before = sess_repo.get_session_row_for_ui(key) or {}
    tid = _resolve_thread_id(key, row_before)
    run_id = peek_current_run_id(session_key=key) or str(row_before.get("currentRunId") or row_before.get("current_run_id") or "").strip() or None

    cancelled: list[str] = []
    orphans: list[str] = []

    if tid:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0, connect=3.0)) as client:
            if user_initiated:
                _unregister_stream_proxy(tid)
                cancelled, orphans = await sweep_langgraph_runs_until_idle(client, tid)
                _reset_collab_on_stop(tid)
            else:
                # chatSend 前置清理：只 cancel 当前/最新 run，不写 DB 终态、不 sweep 历史
                cancelled = await cancel_langgraph_runs_before_send(
                    client,
                    tid,
                    preferred_run_id=run_id,
                )
        try:
            from app.gateway.run_status_reconcile import invalidate_runs_probe_cache

            invalidate_runs_probe_cache(thread_id=tid)
        except Exception:
            logger.debug("invalidate runs probe after stop failed thread=%s", tid, exc_info=True)
        if user_initiated and orphans:
            logger.warning(
                "stop_session_execution: LangGraph orphan runs after sweep session=%s thread=%s orphans=%s",
                key,
                tid,
                orphans,
            )

    if not user_initiated:
        row = sess_repo.get_session_row_for_ui(key)
        return SessionStopResult(
            ok=True,
            session_key=key,
            run_id=run_id,
            phase=str((row or {}).get("runStatus") or (row or {}).get("run_status") or "done"),
            cancelled_run_ids=cancelled,
            session=row,
        )

    result = await mark_session_idle(key, reason=stop_reason)
    result.cancelled_run_ids = cancelled
    if run_id and not result.run_id:
        result.run_id = run_id
    return result
