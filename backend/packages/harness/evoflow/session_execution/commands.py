"""Session execution commands — unified stop / idle transitions."""

from __future__ import annotations

import asyncio
import logging
import os
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

# stop 后兜底对账：LangGraph 协作式取消是异步的（cancel 202 只代表受理），
# 且监听器可能在长任务中超时退出 —— 延迟复查 run 是否真正离开 active，
# 仍在则二次 cancel（可救 cancel POST 临时失败的断链），多轮仍 active 则告警。
_POST_STOP_RECONCILE_DELAY_S = float(os.getenv("EVOFLOW_STOP_RECONCILE_DELAY_S", "20") or "20")
_POST_STOP_RECONCILE_ROUNDS = int(os.getenv("EVOFLOW_STOP_RECONCILE_ROUNDS", "3") or "3")
_pending_reconcile_tasks: set[asyncio.Task] = set()


def _unregister_stream_proxy(thread_id: str | None) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    try:
        from evoflow.runtime.ports import unregister_active_stream_proxy

        unregister_active_stream_proxy(tid)
    except Exception:
        logger.debug("unregister stream proxy on stop failed thread=%s", tid, exc_info=True)


def _resolve_thread_id(session_key: str, row: dict[str, Any] | None) -> str | None:
    data = row or {}
    tid = str(data.get("thread_id") or data.get("threadId") or "").strip()
    return tid or None


def _clear_live_snapshot(session_key: str, thread_id: str | None) -> None:
    try:
        from evoflow.runtime.ports import clear_gateway_live_snapshot

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
    from evoflow.persistence.session_run_state import derive_execution_phase
    from evoflow.session_execution.lifecycle import end_session_turn

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
    logger.info("[STOP-TRACE] 6.db-idle-marked session=%s phase=%s", key, phase)
    return SessionStopResult(
        ok=True,
        session_key=key,
        run_id=run_id,
        phase=phase,
        cancelled_run_ids=[],
        session=row,
    )


def _schedule_post_stop_reconcile(session_key: str, thread_id: str | None, run_ids: list[str]) -> None:
    """mark_session_idle 后兜底对账：确认目标 run 真正离开 active，仍在则二次 cancel。

    LangGraph 协作式取消是异步的（cancel 202 只代表受理），且监听器可能在长任务中
    超时退出 —— 延迟复查仍 active 则再 cancel（可救 cancel POST 临时失败的断链③），
    多轮仍 active 则告警（暴露断链①的协作式取消失效）。任务引用存模块级 set 防 GC。
    """
    targets = [str(rid or "").strip() for rid in run_ids if str(rid or "").strip()]
    tid = str(thread_id or "").strip()
    if not targets or not tid:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    try:
        task = loop.create_task(_post_stop_reconcile(session_key, tid, targets))
    except RuntimeError:
        return
    _pending_reconcile_tasks.add(task)
    task.add_done_callback(_pending_reconcile_tasks.discard)


async def _post_stop_reconcile(session_key: str, thread_id: str, run_ids: list[str]) -> None:
    from evoflow.session_execution.langgraph_cancel import (
        cancel_langgraph_run_ids,
        list_active_langgraph_run_ids,
    )

    delay_s = max(1.0, _POST_STOP_RECONCILE_DELAY_S)
    rounds = max(1, _POST_STOP_RECONCILE_ROUNDS)
    remaining = list(run_ids)
    for round_no in range(1, rounds + 1):
        await asyncio.sleep(delay_s)
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(8.0, connect=3.0)) as client:
                active = await list_active_langgraph_run_ids(client, thread_id)
                leaked = [rid for rid in remaining if rid in active]
                if not leaked:
                    logger.info(
                        "[STOP-TRACE] 8.reconcile-ok session=%s thread=%s round=%d (run 已离开 active)",
                        session_key,
                        thread_id,
                        round_no,
                    )
                    return
                logger.warning(
                    "[STOP-TRACE] 8.reconcile-still-active session=%s thread=%s round=%d runs=%s (二次 cancel)",
                    session_key,
                    thread_id,
                    round_no,
                    leaked,
                )
                await cancel_langgraph_run_ids(client, thread_id, leaked)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning(
                "[STOP-TRACE] 8.reconcile-failed session=%s thread=%s round=%d",
                session_key,
                thread_id,
                round_no,
                exc_info=True,
            )
    logger.warning(
        "[STOP-TRACE] 8.reconcile-exhausted session=%s thread=%s runs=%s (多轮复查仍在 active，可能仍在执行)",
        session_key,
        thread_id,
        remaining,
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

    logger.warning(
        "[STOP-TRACE] 2.cmd-start session=%s tid=%s run_id=%s user_initiated=%s",
        key,
        tid,
        run_id,
        user_initiated,
    )

    cancelled: list[str] = []
    orphans: list[str] = []

    if tid:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0, connect=3.0)) as client:
            if user_initiated:
                _unregister_stream_proxy(tid)
                cancelled, orphans = await sweep_langgraph_runs_until_idle(client, tid)
                _reset_collab_on_stop(tid)
                # Lead stop must also stop thread-pool subagents (they are not LangGraph runs).
                try:
                    from evoflow.subagents.executor import cancel_background_tasks_for_parent_thread

                    bg_cancelled = cancel_background_tasks_for_parent_thread(
                        tid,
                        cancelled_by="user",
                        reason=stop_reason or "parent_session_stopped",
                    )
                    if bg_cancelled:
                        logger.info(
                            "[STOP-TRACE] 3b.subagents-cancelled session=%s tid=%s count=%d ids=%s",
                            key,
                            tid,
                            len(bg_cancelled),
                            bg_cancelled,
                        )
                except Exception:
                    logger.warning(
                        "[STOP-TRACE] 3b.subagents-cancel-failed session=%s tid=%s",
                        key,
                        tid,
                        exc_info=True,
                    )
            else:
                # chatSend 前置清理：只 cancel 当前/最新 run，不写 DB 终态、不 sweep 历史
                cancelled = await cancel_langgraph_runs_before_send(
                    client,
                    tid,
                    preferred_run_id=run_id,
                )
        try:
            from evoflow.runtime.ports import invalidate_runs_probe_cache

            invalidate_runs_probe_cache(thread_id=tid)
        except Exception:
            logger.debug("invalidate runs probe after stop failed thread=%s", tid, exc_info=True)
        if user_initiated:
            logger.info(
                "[STOP-TRACE] 3.sweep-done session=%s tid=%s cancelled=%s orphans=%s",
                key,
                tid,
                cancelled,
                orphans,
            )
            if cancelled:
                _schedule_post_stop_reconcile(key, tid, cancelled)
            if orphans:
                logger.warning(
                    "[STOP-TRACE] 3.sweep-orphan session=%s thread=%s orphans=%s (sweep 超时仍未结束)",
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
