"""Session turn lifecycle — single write funnel for run_status transitions."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from evoflow.persistence.session_run_state import (
    RUN_STATUS_RUNNING,
    mark_session_run_ended,
    mark_session_run_started,
    patch_session_current_run_id,
    peek_current_run_id,
    resolve_terminal_run_status,
)

logger = logging.getLogger(__name__)


def start_session_turn(
    *,
    session_key: str | None = None,
    thread_id: str | None = None,
    run_id: str | None = None,
    status: str = RUN_STATUS_RUNNING,
    source: str = "unknown",
    conn: Any = None,
) -> bool:
    """Mark session run started (DB + mirror clear on new run)."""
    ok = mark_session_run_started(
        session_key=session_key,
        thread_id=thread_id,
        run_id=run_id,
        status=status,
        conn=conn,
    )
    if ok:
        logger.debug(
            "start_session_turn source=%s session=%s thread=%s run=%s",
            source,
            session_key,
            thread_id,
            run_id,
        )
    return ok


def adopt_session_run_id(
    *,
    session_key: str | None = None,
    thread_id: str | None = None,
    run_id: str,
    source: str = "unknown",
) -> bool:
    """Adopt upstream LangGraph run id without clearing stream mirror."""
    ok = patch_session_current_run_id(session_key=session_key, thread_id=thread_id, run_id=run_id)
    if ok:
        logger.debug(
            "adopt_session_run_id source=%s session=%s thread=%s run=%s",
            source,
            session_key,
            thread_id,
            run_id,
        )
    return ok


def force_end_session_turn(
    *,
    session_key: str | None = None,
    thread_id: str | None = None,
    source: str = "force",
    reason: str = "",
    terminal_status: str | None = None,
) -> bool:
    """Synchronously mark terminal run_status (reconcile / channel finalize)."""
    terminal = terminal_status or resolve_terminal_run_status(reason=reason, source=source)
    marked = mark_session_run_ended(
        session_key=session_key,
        thread_id=thread_id,
        terminal_status=terminal,
        reason=reason,
        source=source,
    )
    if marked:
        logger.debug(
            "force_end_session_turn source=%s session=%s thread=%s terminal=%s",
            source,
            session_key,
            thread_id,
            terminal,
        )
        _after_run_ended(session_key=session_key, thread_id=thread_id)
    else:
        logger.warning(
            "force_end_session_turn: mark_session_run_ended returned False "
            "source=%s session_key=%s thread_id=%s terminal=%s — "
            "session_key unresolvable, DB run_status NOT updated",
            source,
            session_key,
            thread_id,
            terminal,
        )
    return marked


def _after_run_ended(*, session_key: str | None = None, thread_id: str | None = None) -> None:
    try:
        from app.gateway.run_status_reconcile import invalidate_runs_probe_cache

        invalidate_runs_probe_cache(thread_id=thread_id)
    except Exception:
        logger.debug("invalidate runs probe after end failed", exc_info=True)
    try:
        from app.gateway.run_status_reconcile import _invalidate_active_sessions_cache

        _invalidate_active_sessions_cache()
    except Exception:
        logger.debug("invalidate active sessions cache after end failed", exc_info=True)


async def end_session_turn(
    *,
    session_key: str | None = None,
    thread_id: str | None = None,
    run_id: str | None = None,
    force: bool = False,
    unregister_proxy: bool = True,
    reason: str = "completed",
    terminal_status: str | None = None,
) -> bool:
    """Mark terminal run_status when LangGraph confirms no active run (unless force)."""
    tid = str(thread_id or "").strip() or None
    if unregister_proxy and tid:
        try:
            from app.gateway.routers.langgraph_proxy import unregister_active_stream_proxy

            unregister_active_stream_proxy(tid)
        except Exception:
            logger.debug("unregister stream proxy failed thread=%s", tid, exc_info=True)

    terminal = terminal_status or resolve_terminal_run_status(reason=reason, source="end_session_turn")

    if force:
        marked = mark_session_run_ended(
            session_key=session_key,
            thread_id=thread_id,
            terminal_status=terminal,
            reason=reason,
            source="force",
        )
        if marked:
            _after_run_ended(session_key=session_key, thread_id=tid)
        return marked

    if not tid:
        try:
            from evoflow.persistence.session_repositories import get_session_row_for_ui

            sk = str(session_key or "").strip()
            if sk:
                row = get_session_row_for_ui(sk) or {}
                tid = str(row.get("thread_id") or row.get("threadId") or "").strip() or None
        except Exception:
            tid = None
    if not tid:
        logger.debug("end_session_turn: no thread_id, skip terminal mark")
        return False

    rid = str(run_id or "").strip() or None
    if not rid:
        try:
            rid = peek_current_run_id(session_key=session_key, thread_id=tid)
        except Exception:
            rid = None

    timeout = httpx.Timeout(connect=3.0, read=8.0, write=8.0, pool=10.0)
    try:
        from app.gateway.run_status_reconcile import is_thread_run_active

        async with httpx.AsyncClient(timeout=timeout) as client:
            active = await is_thread_run_active(client, tid, run_id=rid)
    except Exception:
        logger.debug("end_session_turn: probe failed thread=%s", tid, exc_info=True)
        active = None

    if active is True:
        logger.info("end_session_turn: keeping running thread=%s run=%s", tid, rid or "?")
        return False
    if active is None:
        logger.debug("end_session_turn: LangGraph unreachable, keeping running thread=%s", tid)
        return False

    marked = mark_session_run_ended(
        session_key=session_key,
        thread_id=tid,
        terminal_status=terminal,
        reason=reason,
        source="end_session_turn",
    )
    if marked:
        _after_run_ended(session_key=session_key, thread_id=tid)
        logger.info("end_session_turn: marked %s thread=%s run=%s", terminal, tid, rid or "?")
    return marked


def schedule_end_session_turn(
    *,
    session_key: str | None = None,
    thread_id: str | None = None,
    run_id: str | None = None,
    reason: str = "stream_end",
) -> None:
    """Fire-and-forget probed terminal mark after run_end / stream disconnect."""

    async def _probe_and_maybe_end() -> None:
        await end_session_turn(
            session_key=session_key,
            thread_id=thread_id,
            run_id=run_id,
            reason=reason,
        )

    try:
        asyncio.get_running_loop().create_task(_probe_and_maybe_end())
    except RuntimeError:
        pass
