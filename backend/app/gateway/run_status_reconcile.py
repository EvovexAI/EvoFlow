"""Reconcile SQLite ``run_status`` with LangGraph / in-memory proxy truth.

After gateway or LangGraph restart, ``evoflow_chat_sessions.run_status`` may stay
``running`` while no run is actually active. This module clears those stale rows.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

import httpx

from evoflow.persistence.session_run_state import (
    is_run_status_active,
    is_user_stop_terminal_status,
    list_all_active_sessions,
)
from evoflow.session_execution.lifecycle import force_end_session_turn, start_session_turn

logger = logging.getLogger(__name__)

LANGGRAPH_BASE_URL = os.getenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8070/api/langgraph").rstrip("/")
STREAM_RESUME_INACTIVE_MS = int(os.getenv("EVOFLOW_STREAM_RESUME_INACTIVE_MS", "120000") or "120000")
_RUNS_PROBE_CACHE_TTL_S = float(os.getenv("EVOFLOW_RUNS_PROBE_CACHE_TTL_S", "4") or "4")
_RUNS_PROBE_IDLE_TTL_S = float(os.getenv("EVOFLOW_RUNS_PROBE_IDLE_TTL_S", "12") or "12")
_RUNS_PROBE_CACHE_MAX = 256
_ACTIVE_RUN_STATUSES = frozenset({"pending", "running", "interrupted"})
# Sessions whose active run has been running longer than this threshold (seconds)
# are considered stale and will be cancelled during startup reconciliation.
# Set to 0 to disable stale-run cancellation (legacy behaviour).
_STARTUP_STALE_RUN_MAX_AGE_S = float(os.getenv("EVOFLOW_STARTUP_STALE_RUN_MAX_AGE_S", "180") or "180")
# thread_id[:run_id] -> (monotonic_ts, active: bool | None)
_LIVE_RUN_HEARTBEAT_STALE_S = float(os.getenv("EVOFLOW_LIVE_RUN_HEARTBEAT_STALE_S", "90") or "90")
_RUNS_PROBE_CACHE: dict[str, tuple[float, bool | None]] = {}


def _invalidate_active_sessions_cache() -> None:
    try:
        from app.gateway.routers.langgraph_proxy import _ACTIVE_SESSIONS_CACHE, _ACTIVE_SESSIONS_CACHE_LOCK

        with _ACTIVE_SESSIONS_CACHE_LOCK:
            _ACTIVE_SESSIONS_CACHE.clear()
    except Exception:
        logger.debug("active-sessions cache clear failed", exc_info=True)


def _thread_has_active_proxy(thread_id: str) -> bool:
    try:
        from app.gateway.routers.langgraph_proxy import _active_stream_proxies

        return thread_id in _active_stream_proxies
    except Exception:
        return False


def _collab_phase_is_active(thread_id: str) -> bool:
    try:
        from app.gateway.routers.langgraph_proxy import _collab_phase_is_active as _check

        return _check(thread_id)
    except Exception:
        return False


def _parse_runs_items(runs_data: Any) -> list[dict[str, Any]]:
    items: Any = runs_data
    if isinstance(runs_data, dict):
        items = runs_data.get("items", runs_data.get("runs", []))
    if not isinstance(items, list):
        return []
    return [r for r in items if isinstance(r, dict)]


def _run_created_sort_key(run: dict[str, Any]) -> str:
    """Sort key for newest-first run selection (ISO timestamps sort lexicographically)."""
    for key in ("created_at", "createdAt", "updated_at", "updatedAt"):
        val = str(run.get(key) or "").strip()
        if val:
            return val
    rid = str(run.get("run_id") or run.get("runId") or "").strip()
    return rid


def _runs_probe_cache_key(thread_id: str, run_id: str | None) -> str:
    tid = str(thread_id or "").strip()
    rid = str(run_id or "").strip()
    return f"{tid}:{rid}"


def invalidate_runs_probe_cache(*, thread_id: str | None = None) -> None:
    """Drop cached LangGraph runs probes after run-idle / terminal reconcile."""
    tid = str(thread_id or "").strip()
    if not tid:
        _RUNS_PROBE_CACHE.clear()
        return
    prefix = f"{tid}:"
    for key in list(_RUNS_PROBE_CACHE.keys()):
        if key.startswith(prefix):
            _RUNS_PROBE_CACHE.pop(key, None)


async def _langgraph_has_active_run(
    client: httpx.AsyncClient,
    thread_id: str,
    *,
    run_id: str | None = None,
) -> bool | None:
    """Return True/False if LangGraph responded; None if unreachable."""
    cache_key = _runs_probe_cache_key(thread_id, run_id)
    now = time.monotonic()
    cached = _RUNS_PROBE_CACHE.get(cache_key)
    if cached is not None:
        ts, val = cached
        ttl = _RUNS_PROBE_CACHE_TTL_S if val is True else _RUNS_PROBE_IDLE_TTL_S
        if now - ts < ttl:
            return val

    runs_url = f"{LANGGRAPH_BASE_URL}/threads/{thread_id}/runs"
    try:
        resp = await client.get(runs_url, params={"limit": 20})
    except Exception as e:
        logger.debug("reconcile: runs check failed thread=%s: %s", thread_id, e)
        return None
    # 404 = thread/run catalog gone → definitely not active (do NOT return None:
    # None means "probe failed, skip", which left sticky run_status forever).
    if resp.status_code == 404:
        result: bool | None = False
        _RUNS_PROBE_CACHE[cache_key] = (now, result)
        while len(_RUNS_PROBE_CACHE) > _RUNS_PROBE_CACHE_MAX:
            _RUNS_PROBE_CACHE.pop(next(iter(_RUNS_PROBE_CACHE)), None)
        return result
    if resp.status_code != 200:
        return None
    items = _parse_runs_items(resp.json())
    if not items:
        result = False
    else:
        rid_pref = str(run_id or "").strip()
        result = False
        if rid_pref:
            for r in items:
                rid = r.get("run_id") or r.get("runId")
                if rid is None or str(rid) != rid_pref:
                    continue
                st = str(r.get("status") or "").strip().lower()
                if st in _ACTIVE_RUN_STATUSES:
                    result = True
                    break
        if not result:
            for r in items:
                st = str(r.get("status") or "").strip().lower()
                if st in _ACTIVE_RUN_STATUSES:
                    result = True
                    break

    _RUNS_PROBE_CACHE[cache_key] = (now, result)
    while len(_RUNS_PROBE_CACHE) > _RUNS_PROBE_CACHE_MAX:
        _RUNS_PROBE_CACHE.pop(next(iter(_RUNS_PROBE_CACHE)), None)
    return result


async def discover_active_run_id(
    client: httpx.AsyncClient,
    thread_id: str,
    *,
    preferred_run_id: str | None = None,
) -> str | None:
    """Return the newest pending/running run id for a thread (if any)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    runs_url = f"{LANGGRAPH_BASE_URL}/threads/{tid}/runs"
    try:
        resp = await client.get(runs_url, params={"limit": 20})
    except Exception:
        logger.debug("discover_active_run_id failed thread=%s", tid, exc_info=True)
        return None
    if resp.status_code != 200:
        return None
    items = _parse_runs_items(resp.json())
    pref = str(preferred_run_id or "").strip()
    active_runs: list[dict[str, Any]] = []
    for r in items:
        st = str(r.get("status") or "").strip().lower()
        if st not in _ACTIVE_RUN_STATUSES:
            continue
        rid = str(r.get("run_id") or r.get("runId") or "").strip()
        if rid:
            active_runs.append(r)
    if not active_runs:
        return None
    if pref:
        for r in active_runs:
            rid = str(r.get("run_id") or r.get("runId") or "").strip()
            if rid == pref:
                return rid
    active_runs.sort(key=_run_created_sort_key, reverse=True)
    newest = active_runs[0]
    return str(newest.get("run_id") or newest.get("runId") or "").strip() or None


async def ensure_session_run_active(
    client: httpx.AsyncClient,
    *,
    session_key: str,
    thread_id: str,
    run_id: str | None = None,
) -> tuple[bool | None, str | None]:
    """Probe LangGraph and heal SQLite ``run_status`` when a live run still exists.

    Returns ``(active, run_id)`` where *active* is True/False when LangGraph responded,
    or None when unreachable.
    """
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    if not sk or not tid:
        return False, None

    rid = str(run_id or "").strip() or None
    active = await is_thread_run_active(client, tid, run_id=rid)
    if active is not True:
        return active, rid

    if not rid:
        rid = await discover_active_run_id(client, tid, preferred_run_id=run_id)

    try:
        from evoflow.persistence.session_repositories import get_session_row_for_ui

        row = get_session_row_for_ui(sk) or {}
    except Exception:
        row = {}
    db_st = str(row.get("run_status") or row.get("runStatus") or "idle").strip().lower()
    db_rid = str(row.get("current_run_id") or row.get("currentRunId") or "").strip() or None
    if is_user_stop_terminal_status(db_st):
        logger.info(
            "ensure_session_run_active: skip heal — user-stop terminal session=%s thread=%s",
            sk,
            tid,
        )
        return active, rid or db_rid
    if not is_run_status_active(db_st) or (rid and db_rid != rid):
        start_session_turn(session_key=sk, thread_id=tid, run_id=rid, source="ensure_active")
        _invalidate_active_sessions_cache()
        logger.info(
            "ensure_session_run_active: healed idle->running session=%s thread=%s run=%s",
            sk,
            tid,
            rid or "?",
        )
    return True, rid or db_rid


async def is_thread_run_active(
    client: httpx.AsyncClient,
    thread_id: str,
    *,
    run_id: str | None = None,
) -> bool | None:
    """True if chat run is active; None if LangGraph could not be queried."""
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    if _thread_has_active_proxy(tid):
        return True
    if _collab_phase_is_active(tid):
        return True
    return await _langgraph_has_active_run(client, tid, run_id=run_id)


def _parse_ts_to_unix(ts_str: str) -> float:
    """Parse ISO-8601 timestamp to Unix seconds (best-effort, 0 on failure)."""
    try:
        from datetime import datetime

        s = ts_str.strip().replace("Z", "+00:00")
        return datetime.fromisoformat(s).timestamp()
    except Exception:
        return 0.0


def _is_session_run_stale(row: dict[str, Any]) -> bool:
    """Return True if the session's active run exceeds the staleness threshold.

    **Staleness is determined by the *last activity* time, not the turn start
    time.**  ``currentTurnStartedAt`` is written once when the turn begins and
    never refreshed — using it would falsely flag any long-running task
    (e.g. a 15-minute sub-agent research) as stale.

    The preferred signal is ``live_run_snapshot.last_event_at_ms``, which the
    frontend updates every ~2 seconds during streaming.  If no live snapshot
    exists, we fall back to ``updatedAt`` (refreshed on DB writes like
    token accumulation).
    """
    if _STARTUP_STALE_RUN_MAX_AGE_S <= 0:
        return False
    now_s = time.time()
    # updatedAt — epoch-ms (int) per get_session_row_for_ui; updated_at — ISO string in raw rows
    updated_raw = row.get("updatedAt") or row.get("updated_at")
    candidates: list[float] = []
    if updated_raw:
        if isinstance(updated_raw, (int, float)):
            candidates.append(float(updated_raw) / 1000.0)
        elif isinstance(updated_raw, str):
            candidates.append(_parse_ts_to_unix(updated_raw))
    for ts in candidates:
        if ts and ts > 0 and (now_s - ts) >= _STARTUP_STALE_RUN_MAX_AGE_S:
            return True
    return False


def _live_snapshot_is_stale(session_key: str) -> bool:
    """Check ``evoflow_chat_live_runs.last_event_at`` for true heartbeat freshness.

    The frontend PUTs a live-run snapshot every ~2s during streaming with
    ``lastEventAtMs``.  If the snapshot exists and its last event is older
    than the threshold, the run is genuinely stale (client disconnected or
    hung).  If no snapshot exists at all, returns ``False`` (caller falls
    back to ``_is_session_run_stale`` using ``updatedAt``).
    """
    if _STARTUP_STALE_RUN_MAX_AGE_S <= 0:
        return False
    try:
        from evoflow.persistence.live_run_repositories import get_live_run_snapshot

        snap = get_live_run_snapshot(session_key)
        if not snap:
            return False  # no snapshot — let caller use updatedAt fallback
        last_event_ms = int(snap.get("lastEventAtMs") or 0)
        if last_event_ms <= 0:
            return False  # snapshot exists but no event timestamp — not enough info
        age_s = time.time() - (last_event_ms / 1000.0)
        # Fast-path: heartbeat stopped for 90s -> stale regardless of main threshold
        if age_s >= _LIVE_RUN_HEARTBEAT_STALE_S:
            return True
        return age_s >= _STARTUP_STALE_RUN_MAX_AGE_S
    except Exception:
        logger.debug("live snapshot stale check failed session=%s", session_key, exc_info=True)
        return False


def _run_has_active_client(thread_id: str) -> bool:
    """Return True if a client is actively streaming (SSE/WS proxy attached).

    An active stream proxy means the frontend is connected and receiving
    events — the run is alive regardless of how long it has been running.
    """
    return _thread_has_active_proxy(thread_id)


async def _cancel_stale_active_run(session_key: str, thread_id: str) -> None:
    """Cancel a stale active run (best-effort, fast path for startup reconcile).

    Uses ``stop_session_execution(user_initiated=False)`` to cancel only the
    current/preferred LangGraph run (avoids the multi-second sweep), then
    unconditionally marks the session idle in DB so the UI reflects the stop.
    """
    try:
        from evoflow.session_execution import stop_session_execution

        await stop_session_execution(session_key, user_initiated=False, reason="startup_stale_cancel")
    except Exception:
        logger.warning(
            "reconcile: cancel stale run failed session=%s thread=%s",
            session_key,
            thread_id,
            exc_info=True,
        )
    # stop_session_execution(user_initiated=False) does not write terminal DB
    # status, so always mark idle here.
    try:
        force_end_session_turn(
            session_key=session_key, thread_id=thread_id, source="startup_stale_cancel"
        )
        _invalidate_active_sessions_cache()
    except Exception:
        logger.debug(
            "reconcile: force_end_session_turn failed session=%s", session_key, exc_info=True
        )


async def reconcile_session_run_row(
    client: httpx.AsyncClient,
    *,
    session_key: str,
    thread_id: str | None,
    run_id: str | None = None,
) -> str:
    """Return action: ``kept`` | ``cleared`` | ``skipped``."""
    import time

    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    if not sk:
        return "skipped"
    if not tid:
        force_end_session_turn(session_key=sk, source="reconcile_no_thread")
        _invalidate_active_sessions_cache()
        return "cleared"

    try:
        from evoflow.persistence.stream_mirror_repositories import clear_mirror, get_mirror_meta

        meta = get_mirror_meta(sk)
        if meta and not meta.get("unavailable"):
            updated_ms = int(meta.get("updatedAtMs") or 0)
            if updated_ms and (time.time() * 1000 - updated_ms) >= STREAM_RESUME_INACTIVE_MS:
                stale_active = await is_thread_run_active(client, tid, run_id=run_id)
                if stale_active is False:
                    clear_mirror(sk)
                    force_end_session_turn(session_key=sk, thread_id=tid, source="reconcile_stale_mirror")
                    _invalidate_active_sessions_cache()
                    return "cleared"
    except Exception:
        logger.debug("reconcile mirror stale check failed session=%s", sk, exc_info=True)

    active = await is_thread_run_active(client, tid, run_id=run_id)
    if active is None:
        return "skipped"
    if active:
        try:
            from evoflow.persistence.session_repositories import get_session_row_for_ui

            row = get_session_row_for_ui(sk) or {}
            db_st = str(row.get("run_status") or row.get("runStatus") or "idle").strip().lower()
            if is_user_stop_terminal_status(db_st):
                logger.info(
                    "reconcile: skip heal — user-stop terminal session=%s thread=%s",
                    sk,
                    tid,
                )
                return "kept"
            if not is_run_status_active(db_st):
                rid = run_id or await discover_active_run_id(client, tid, preferred_run_id=run_id)
                start_session_turn(session_key=sk, thread_id=tid, run_id=rid, source="reconcile_heal")
                _invalidate_active_sessions_cache()
                return "healed"

            # Stale active run: cancel only if the run is genuinely idle.
            # Three-tier check to avoid killing long-running but healthy tasks:
            #   1. Active stream proxy (client connected) → alive, skip
            #   2. Live-run snapshot with recent heartbeat → alive, skip
            #   3. No snapshot + updatedAt is old → stale, cancel
            if _run_has_active_client(tid):
                logger.debug(
                    "reconcile: skip stale cancel — active stream proxy session=%s thread=%s",
                    sk, tid,
                )
                return "kept"
            if _live_snapshot_is_stale(sk):
                logger.info(
                    "reconcile: cancelling stale run (live snapshot heartbeat lost) session=%s thread=%s run=%s",
                    sk, tid, run_id or "?",
                )
                await _cancel_stale_active_run(sk, tid)
                return "cancelled"
            if _is_session_run_stale(row):
                logger.info(
                    "reconcile: cancelling stale run (updatedAt timeout, no live snapshot) session=%s thread=%s run=%s",
                    sk, tid, run_id or "?",
                )
                await _cancel_stale_active_run(sk, tid)
                return "cancelled"
        except Exception:
            logger.debug("reconcile heal idle->running failed session=%s", sk, exc_info=True)
        return "kept"
    try:
        from evoflow.persistence.stream_mirror_repositories import clear_mirror

        clear_mirror(sk)
    except Exception:
        logger.debug("reconcile clear mirror failed session=%s", sk, exc_info=True)
    force_end_session_turn(session_key=sk, thread_id=tid, source="reconcile_clear")
    _invalidate_active_sessions_cache()
    return "cleared"


async def reconcile_stale_session_runs(
    *,
    wait_for_langgraph: bool = True,
    max_sessions: int = 500,
) -> dict[str, int]:
    """Clear SQLite running/pending rows with no live LangGraph run or proxy stream."""
    stats = {"scanned": 0, "kept": 0, "cleared": 0, "cancelled": 0, "healed": 0, "skipped": 0}
    rows = list_all_active_sessions(limit=max_sessions)
    if not rows:
        return stats

    if wait_for_langgraph:
        from app.gateway.routers.langgraph_proxy import _wait_langgraph_ready

        ready = await _wait_langgraph_ready(attempts=15, delay_seconds=0.4)
        if not ready:
            logger.warning(
                "run_status reconcile: LangGraph not ready; skipping startup reconciliation (%d stale rows)",
                len(rows),
            )
            stats["skipped"] = len(rows)
            return stats

    timeout = httpx.Timeout(connect=3.0, read=8.0, write=8.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for row in rows:
            stats["scanned"] += 1
            action = await reconcile_session_run_row(
                client,
                session_key=str(row.get("session_key") or ""),
                thread_id=row.get("thread_id"),
                run_id=row.get("run_id"),
            )
            stats[action] = stats.get(action, 0) + 1

    if stats["cleared"] or stats.get("cancelled"):
        logger.info(
            "run_status reconcile: cleared=%d cancelled=%d kept=%d healed=%d skipped=%d scanned=%d",
            stats["cleared"],
            stats.get("cancelled", 0),
            stats["kept"],
            stats.get("healed", 0),
            stats["skipped"],
            stats["scanned"],
        )
    return stats


async def reconcile_ui_session_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Clear stale ``runStatus=running`` rows before returning session list to the client.

    Deprecated: list API no longer calls this (use GET .../execution/state or startup reconcile).
    """
    active_rows = [
        r
        for r in rows
        if str(r.get("runStatus") or "").strip().lower() in _ACTIVE_RUN_STATUSES
        and str(r.get("threadId") or r.get("thread_id") or "").strip()
    ]
    if not active_rows:
        return rows

    timeout = httpx.Timeout(connect=2.0, read=6.0, write=6.0, pool=8.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for row in active_rows:
            sk = str(row.get("sessionKey") or row.get("session_key") or "").strip()
            tid = str(row.get("threadId") or row.get("thread_id") or "").strip()
            rid = str(row.get("currentRunId") or row.get("current_run_id") or "").strip() or None
            action = await reconcile_session_run_row(
                client,
                session_key=sk,
                thread_id=tid,
                run_id=rid,
            )
            if action == "cleared":
                row["runStatus"] = "done"
                row["currentRunId"] = None

    return rows


async def maybe_mark_session_run_ended(
    *,
    session_key: str | None = None,
    thread_id: str | None = None,
    run_id: str | None = None,
    force: bool = False,
    unregister_proxy: bool = True,
) -> bool:
    """Deprecated alias — use ``evoflow.session_execution.end_session_turn``."""
    from evoflow.session_execution.lifecycle import end_session_turn

    return await end_session_turn(
        session_key=session_key,
        thread_id=thread_id,
        run_id=run_id,
        force=force,
        unregister_proxy=unregister_proxy,
        reason="reconcile",
    )


def thread_has_live_gateway_stream(thread_id: str | None) -> bool:
    """True when Gateway still holds an active SSE proxy for this thread."""
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    return _thread_has_active_proxy(tid) or _collab_phase_is_active(tid)


async def notify_attach_run_terminal(
    thread_id: str | None,
    *,
    run_id: str | None = None,
) -> None:
    """Attach stream saw a terminal run — mark session idle (caller already verified run ended)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return
    try:
        marked = force_end_session_turn(thread_id=tid, source="attach_terminal")
        if not marked:
            return
        logger.info("notify_attach_run_terminal: marked idle thread=%s run=%s", tid, run_id or "?")
        try:
            from app.gateway.streaming.live_run_snapshot import clear_gateway_live_snapshot

            clear_gateway_live_snapshot(tid)
        except Exception:
            logger.debug("notify_attach_run_terminal clear snapshot failed thread=%s", tid, exc_info=True)
    except Exception:
        logger.debug("notify_attach_run_terminal failed thread_id=%s", tid, exc_info=True)


async def sweep_expired_stream_mirrors_on_startup() -> dict[str, int]:
    """Remove expired mirror blobs for idle/deleted sessions (see stream_mirror_repositories)."""
    try:
        from evoflow.persistence.stream_mirror_repositories import sweep_expired_idle_mirrors

        stats = await asyncio.to_thread(sweep_expired_idle_mirrors)
        if stats.get("cleared"):
            logger.info(
                "stream mirror sweep: cleared=%d scanned=%d",
                stats.get("cleared", 0),
                stats.get("scanned", 0),
            )
        return stats
    except Exception:
        logger.exception("stream mirror sweep at startup failed")
        return {"scanned": 0, "cleared": 0}


async def wait_and_reconcile_on_startup() -> None:
    """Background-friendly startup hook (called from gateway lifespan)."""
    try:
        await asyncio.sleep(0.5)
        await reconcile_stale_session_runs(wait_for_langgraph=True)
    except Exception:
        logger.exception("run_status reconcile at startup failed")
    try:
        await sweep_expired_stream_mirrors_on_startup()
    except Exception:
        logger.exception("stream mirror sweep hook failed")


__all__ = [
    "discover_active_run_id",
    "ensure_session_run_active",
    "invalidate_runs_probe_cache",
    "is_thread_run_active",
    "maybe_mark_session_run_ended",
    "notify_attach_run_terminal",
    "reconcile_session_run_row",
    "reconcile_stale_session_runs",
    "reconcile_ui_session_rows",
    "sweep_expired_stream_mirrors_on_startup",
    "thread_has_live_gateway_stream",
    "wait_and_reconcile_on_startup",
]
