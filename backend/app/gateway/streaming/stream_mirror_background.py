"""Background mirror writer helpers (join/tail disabled — use ``StreamMiddleLayer``)."""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_active_writers: set[str] = set()
_JOIN_STREAM_MODES = ("messages-tuple", "values", "custom")


def _join_cancel_on_disconnect() -> str:
    raw = (os.getenv("EVOFLOW_MIRROR_JOIN_CANCEL_ON_DISCONNECT", "false") or "false").strip().lower()
    return "true" if raw in {"1", "true", "yes", "on"} else "false"


async def _resolve_run_id(thread_id: str, run_id: str | None) -> str | None:
    """Resolve LangGraph run id (not client-side optimistic uuid from run-active)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    pref = str(run_id or "").strip() or None
    try:
        from app.gateway.run_status_reconcile import discover_active_run_id

        timeout = httpx.Timeout(connect=5.0, read=15.0, write=15.0, pool=30.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            lg_rid = await discover_active_run_id(client, tid, preferred_run_id=pref)
        if lg_rid:
            return lg_rid
    except Exception:
        pass
    if pref:
        return pref
    try:
        from evoflow.persistence.session_run_state import peek_current_run_id

        return str(peek_current_run_id(thread_id=tid) or "").strip() or None
    except Exception:
        return None


async def _resolve_session_key(thread_id: str, session_key: str | None) -> str | None:
    sk = str(session_key or "").strip()
    if sk:
        return sk
    try:
        from app.gateway.db_async import run_db
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        return await run_db(find_session_key_by_thread_id, thread_id) or None
    except Exception:
        return None


async def _wait_for_run_id(
    thread_id: str,
    run_id: str | None,
    *,
    timeout_s: float = 120.0,
    poll_s: float = 0.25,
) -> str | None:
    """Poll until LangGraph assigns a run id (POST /runs/stream creates it shortly after accept)."""
    import asyncio
    import time

    tid = str(thread_id or "").strip()
    if not tid:
        return None
    pref = str(run_id or "").strip() or None
    deadline = time.monotonic() + max(1.0, float(timeout_s))
    while time.monotonic() < deadline:
        rid = await _resolve_run_id(tid, pref)
        if rid:
            # POST /runs/stream may still be creating the LangGraph run; prefer the newest id.
            await asyncio.sleep(min(0.5, max(0.1, float(poll_s))))
            newer = await _resolve_run_id(tid, pref)
            if newer:
                return newer
            return rid
        await asyncio.sleep(max(0.1, float(poll_s)))
    return await _resolve_run_id(tid, pref)


async def is_run_still_active(*, thread_id: str, run_id: str | None = None) -> bool:
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    try:
        from app.gateway.db_async import run_db
        from evoflow.agents.tool_approval_service import thread_has_pending_approvals

        if await run_db(thread_has_pending_approvals, tid):
            return True
    except Exception:
        pass
    try:
        from app.gateway.run_status_reconcile import _langgraph_has_active_run

        timeout = httpx.Timeout(connect=5.0, read=15.0, write=15.0, pool=30.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            active = await _langgraph_has_active_run(client, tid, run_id=run_id)
        if active is True:
            return True
        if active is False:
            return False
    except Exception:
        pass
    try:
        from evoflow.persistence.session_run_state import is_run_status_active, peek_current_run_id

        if await run_db(peek_current_run_id, thread_id=tid):
            return True
        sk = await _resolve_session_key(tid, None)
        if sk:
            def _session_run_status_active() -> bool:
                from evoflow.persistence.db import get_db

                row = get_db().execute(
                    "SELECT run_status FROM evoflow_chat_sessions WHERE session_key = ? AND is_deleted = 0",
                    (sk,),
                ).fetchone()
                return bool(row and is_run_status_active(str(row[0] or "")))

            if await run_db(_session_run_status_active):
                return True
    except Exception:
        pass
    return False


async def is_run_still_active_for_middle_layer(*, thread_id: str, run_id: str | None = None) -> bool:
    """Continuation probe for POST middle layer — never trust stale SQLite run_status."""
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    try:
        from app.gateway.db_async import run_db
        from evoflow.agents.tool_approval_service import thread_has_pending_approvals

        if await run_db(thread_has_pending_approvals, tid):
            return True
    except Exception:
        pass
    try:
        from app.gateway.streaming.session_stream_inject import (
            _has_pending_collab_subtasks_async,
            _inject_queue_has_pending,
        )

        if await _has_pending_collab_subtasks_async(tid):
            return True
        if _inject_queue_has_pending(tid):
            return True
    except Exception:
        pass
    try:
        from app.gateway.run_status_reconcile import _langgraph_has_active_run

        timeout = httpx.Timeout(connect=5.0, read=15.0, write=15.0, pool=30.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            active = await _langgraph_has_active_run(client, tid, run_id=run_id)
        if active is True:
            return True
        if active is False:
            return False
    except Exception:
        pass
    return False


def _get_inprocess_lg_app() -> Any | None:
    try:
        from app.gateway.app import app

        return getattr(app.state, "_lg_app", None)
    except Exception:
        return None


async def _join_native_run_stream_inprocess(
    lg_app: Any,
    *,
    thread_id: str,
    run_id: str,
) -> bool:
    """Stream LangGraph native join SSE via in-process ASGI (bypasses Gateway attach route)."""
    import asyncio

    tid = str(thread_id or "").strip()
    rid = str(run_id or "").strip()
    if not tid or not rid:
        return False

    q: asyncio.Queue[bytes | None] = asyncio.Queue()
    response_status = 0
    stream_error: BaseException | None = None

    async def _send(message: dict) -> None:
        nonlocal response_status
        if message.get("type") == "http.response.start":
            response_status = int(message.get("status") or 0)
        elif message.get("type") == "http.response.body":
            body = message.get("body") or b""
            if body:
                await q.put(bytes(body))
            if not message.get("more_body", True):
                await q.put(None)

    async def _receive() -> dict:
        await asyncio.sleep(3600)
        return {"type": "http.disconnect"}

    query = "&".join(
        [f"cancel_on_disconnect={_join_cancel_on_disconnect()}"]
        + [f"stream_mode={mode}" for mode in _JOIN_STREAM_MODES]
    )
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": f"/threads/{tid}/runs/{rid}/stream",
        "raw_path": f"/threads/{tid}/runs/{rid}/stream".encode(),
        "query_string": query.encode("latin-1"),
        "headers": [],
        "client": ("127.0.0.1", 0),
        "server": ("127.0.0.1", 8070),
    }

    async def _pump_upstream() -> None:
        nonlocal stream_error
        try:
            await lg_app(scope, _receive, _send)
        except BaseException as exc:
            stream_error = exc
        finally:
            await q.put(None)

    pump = asyncio.create_task(_pump_upstream())
    try:
        while True:
            if not await is_run_still_active(thread_id=tid, run_id=rid):
                pump.cancel()
                break
            chunk = await q.get()
            if chunk is None:
                break
            from app.gateway.streaming.stream_mirror_lane import feed_mirror_lane_upstream

            feed_mirror_lane_upstream(tid, chunk, source="background-join")
    finally:
        if not pump.done():
            pump.cancel()
            try:
                await pump
            except (asyncio.CancelledError, Exception):
                pass

    if stream_error and response_status == 0:
        logger.debug(
            "background mirror in-process join failed thread=%s run=%s",
            tid,
            rid,
            exc_info=stream_error,
        )
        return False
    if response_status and response_status != 200:
        return False
    return response_status == 200


async def _join_run_stream_via_httpx(
    *,
    thread_id: str,
    run_id: str,
) -> bool:
    """Attach via HTTP join stream; returns True when join HTTP 200 and stream opened."""
    import asyncio

    from app.gateway.run_status_reconcile import LANGGRAPH_BASE_URL
    from evoflow.runtime.long_run_limits import LONG_RUN_STREAM_READ_SECONDS, httpx_stream_timeout

    tid = str(thread_id or "").strip()
    rid = str(run_id or "").strip()
    if not tid or not rid:
        return False

    join_url = f"{LANGGRAPH_BASE_URL.rstrip('/')}/threads/{tid}/runs/{rid}/stream"
    params: list[tuple[str, str]] = [
        ("cancel_on_disconnect", _join_cancel_on_disconnect()),
    ]
    for mode in _JOIN_STREAM_MODES:
        params.append(("stream_mode", mode))

    timeout = httpx_stream_timeout()
    timeout = httpx.Timeout(
        connect=min(10.0, float(timeout.connect or 10.0)),
        read=float(LONG_RUN_STREAM_READ_SECONDS),
        write=min(60.0, float(timeout.write or 60.0)),
        pool=float(timeout.pool or 120.0),
    )

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            async with client.stream("GET", join_url, params=params) as resp:
                if resp.status_code != 200:
                    return False
                async for chunk in resp.aiter_bytes():
                    if chunk:
                        from app.gateway.streaming.stream_mirror_lane import feed_mirror_lane_upstream

                        feed_mirror_lane_upstream(tid, chunk, source="background-join")
                    if not await is_run_still_active(thread_id=tid, run_id=rid):
                        break
                return True
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug(
                "background mirror httpx join failed thread=%s run=%s",
                tid,
                rid,
                exc_info=True,
            )
            return False


async def _join_run_stream_once(
    *,
    thread_id: str,
    run_id: str,
) -> bool:
    """One join attempt (in-process ASGI first, then httpx)."""
    tid = str(thread_id or "").strip()
    rid = str(run_id or "").strip()
    if not tid or not rid:
        return False

    lg_app = _get_inprocess_lg_app()
    if lg_app is not None:
        joined_ok = await _join_native_run_stream_inprocess(
            lg_app,
            thread_id=tid,
            run_id=rid,
        )
        if joined_ok:
            return True
    return await _join_run_stream_via_httpx(thread_id=tid, run_id=rid)


async def run_background_mirror_writer(
    *,
    thread_id: str,
    run_id: str | None = None,
    session_key: str | None = None,
    body: bytes = b"",
    stream_format: str = "agui",
) -> None:
    """Disabled — mirror frames come only from ``StreamMiddleLayer`` (POST upstream)."""
    return


def launch_background_mirror_writer(
    *,
    thread_id: str,
    run_id: str | None = None,
    session_key: str | None = None,
    body: bytes = b"",
    stream_format: str = "agui",
) -> Any:
    """Fire-and-forget background mirror writer (checks run active first)."""
    import asyncio

    tid = str(thread_id or "").strip()
    if not tid:
        return None

    async def _runner() -> None:
        await run_background_mirror_writer(
            thread_id=tid,
            run_id=run_id,
            session_key=session_key,
            body=body,
            stream_format=stream_format,
        )

    try:
        loop = asyncio.get_running_loop()
        return loop.create_task(_runner())
    except RuntimeError:
        return None
