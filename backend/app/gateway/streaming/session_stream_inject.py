"""Inject subtask ``custom`` events into the active main chat ``runs/stream``."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections.abc import AsyncIterator
from typing import Any

logger = logging.getLogger(__name__)

_inject_queues: dict[str, asyncio.Queue[dict[str, Any]]] = {}
_refcounts: dict[str, int] = {}
# Upstream/tail poll defaults — override via env for tuning without code changes.
_DEFAULT_UPSTREAM_POLL_S = max(0.05, min(1.0, float(os.getenv("EVOFLOW_STREAM_INJECT_POLL_S", "0.2") or "0.2")))
_DEFAULT_TAIL_POLL_S = max(0.25, min(5.0, float(os.getenv("EVOFLOW_STREAM_INJECT_TAIL_POLL_S", "0.75") or "0.75")))
_COLLAB_PENDING_CACHE_TTL_S = max(0.5, min(10.0, float(os.getenv("EVOFLOW_STREAM_INJECT_COLLAB_CACHE_S", "1.0") or "1.0")))
_collab_pending_cache: dict[str, tuple[float, bool]] = {}
# Safety timeout: absolute cap for tail polling.  Resets each time a new inject
# event arrives. Default 5 min (was 30 min) — long hangs hurt concurrent streams.
_TAIL_PHASE_MAX_S = max(
    60.0,
    min(3600.0, float(os.getenv("EVOFLOW_STREAM_INJECT_TAIL_MAX_S", "300") or "300")),
)
# Idle cap when collab phase says active but no inject traffic and no in-flight subtasks.
_TAIL_IDLE_MAX_S = 120.0
_ACTIVE_COLLAB_TAIL_PHASES = frozenset({"executing", "running", "verifying"})
_IN_FLIGHT_SUBTASK_STATUSES = frozenset({"executing", "running", "in_progress"})
_CLAIMABLE_SUBTASK_STATUSES = frozenset({"pending", "planned", "waiting_dispatch"})
_ACTIVE_MAIN_TASK_STATUSES = frozenset({"executing", "planned", "pending"})


def _inject_queue_has_pending(thread_id: str) -> bool:
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    q = _inject_queues.get(tid)
    return q is not None and not q.empty()


def _bundle_tail_should_stay_open(bundle: dict[str, Any]) -> bool:
    main_status = str(bundle.get("status") or "").strip().lower()
    tasks = bundle.get("tasks")
    if not isinstance(tasks, list):
        return False
    has_in_flight = False
    has_claimable = False
    for task in tasks:
        if not isinstance(task, dict):
            continue
        subs = task.get("subtasks")
        if not isinstance(subs, list):
            continue
        for sub in subs:
            if not isinstance(sub, dict):
                continue
            status = str(sub.get("status") or "").strip().lower()
            if status in _IN_FLIGHT_SUBTASK_STATUSES:
                has_in_flight = True
            elif status in _CLAIMABLE_SUBTASK_STATUSES:
                has_claimable = True
    if has_in_flight:
        return True
    return has_claimable and main_status in _ACTIVE_MAIN_TASK_STATUSES


def _invalidate_collab_pending_cache(thread_id: str) -> None:
    tid = str(thread_id or "").strip()
    if tid:
        _collab_pending_cache.pop(tid, None)


def _has_pending_collab_subtasks(thread_id: str) -> bool:
    """Check whether the SSE stream should stay open after the LangGraph run ends.

    Follow-up collab DAG waves emit events via the inject queue and need an active
    reader.  Phase alone is not enough — a stale ``executing`` on disk with no
    in-flight subtasks should not hold the connection for 30 minutes.

    Sync only — do not call from the Gateway asyncio event loop (use
    ``_has_pending_collab_subtasks_async``).
    """
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    if _inject_queue_has_pending(tid):
        return True
    now = time.monotonic()
    cached = _collab_pending_cache.get(tid)
    if cached is not None and (now - cached[0]) < _COLLAB_PENDING_CACHE_TTL_S:
        return cached[1]
    result = _load_pending_collab_subtasks_from_disk(tid)
    _collab_pending_cache[tid] = (now, result)
    return result


async def _has_pending_collab_subtasks_async(thread_id: str) -> bool:
    """Async variant: offloads disk reads so the event loop never blocks on SQLite."""
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    if _inject_queue_has_pending(tid):
        return True
    now = time.monotonic()
    cached = _collab_pending_cache.get(tid)
    if cached is not None and (now - cached[0]) < _COLLAB_PENDING_CACHE_TTL_S:
        return cached[1]
    from app.gateway.db_async import run_db

    try:
        result = await run_db(_load_pending_collab_subtasks_from_disk, tid)
    except Exception:
        logger.debug("_has_pending_collab_subtasks_async check failed thread=%s", tid, exc_info=True)
        result = False
    _collab_pending_cache[tid] = (now, result)
    return result


def _load_pending_collab_subtasks_from_disk(thread_id: str) -> bool:
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    try:
        from evoflow.collab.thread_collab import load_thread_collab_state
        from evoflow.config.paths import get_paths
        from evoflow.persistence.repositories import load_task_bundle

        collab_state = load_thread_collab_state(get_paths(), tid)
        phase = getattr(collab_state, "collab_phase", None)
        phase_str = getattr(phase, "value", phase)
        phase_str = str(phase_str).strip().lower() if phase_str is not None else "idle"
        if phase_str not in _ACTIVE_COLLAB_TAIL_PHASES:
            return False
        bound_task_id = str(getattr(collab_state, "bound_task_id", None) or "").strip()
        if not bound_task_id:
            return False
        bundle = load_task_bundle(bound_task_id)
        if not isinstance(bundle, dict):
            return False
        return _bundle_tail_should_stay_open(bundle)
    except Exception:
        logger.debug("_has_pending_collab_subtasks check failed thread=%s", tid, exc_info=True)
    return False


def format_langgraph_custom_frame(data: dict[str, Any]) -> bytes:
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"event: custom\ndata: {body}\n\n".encode()


def format_evf_custom_frame(data: dict[str, Any]) -> bytes:
    from app.gateway.sse_ui_normalize import _encode_evf

    return _encode_evf({"type": "custom", "chunk": dict(data)})


def format_evf_direct_frame(payload: dict[str, Any]) -> bytes:
    from app.gateway.sse_ui_normalize import _encode_evf

    return _encode_evf(dict(payload))


def begin_thread_inject(thread_id: str) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    _refcounts[tid] = _refcounts.get(tid, 0) + 1
    if tid not in _inject_queues:
        _inject_queues[tid] = asyncio.Queue(maxsize=512)


def end_thread_inject(thread_id: str) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    n = _refcounts.get(tid, 0) - 1
    if n <= 0:
        _refcounts.pop(tid, None)
        _inject_queues.pop(tid, None)
    else:
        _refcounts[tid] = n


def has_active_inject(thread_id: str) -> bool:
    tid = str(thread_id or "").strip()
    return tid in _inject_queues


def _drain_payloads(thread_id: str) -> list[dict[str, Any]]:
    tid = str(thread_id or "").strip()
    q = _inject_queues.get(tid)
    if q is None:
        return []
    out: list[dict[str, Any]] = []
    while True:
        try:
            item = q.get_nowait()
        except asyncio.QueueEmpty:
            break
        if isinstance(item, dict):
            out.append(item)
    return out


def drain_inject_evf_payloads(thread_id: str) -> list[dict[str, Any]]:
    """Drain inject queue as semantic EVF payloads (no wire encode)."""
    out: list[dict[str, Any]] = []
    for data in _drain_payloads(thread_id):
        if isinstance(data, dict) and isinstance(data.get("__evf__"), dict):
            out.append(dict(data["__evf__"]))
        else:
            out.append({"type": "custom", "chunk": dict(data)})
    return out


def drain_inject_evf_frames(thread_id: str) -> list[bytes]:
    out: list[bytes] = []
    for data in _drain_payloads(thread_id):
        if isinstance(data, dict) and isinstance(data.get("__evf__"), dict):
            out.append(format_evf_direct_frame(data["__evf__"]))
        else:
            out.append(format_evf_custom_frame(data))
    return out


def drain_inject_langgraph_frames(thread_id: str) -> list[bytes]:
    return [format_langgraph_custom_frame(data) for data in _drain_payloads(thread_id)]


def _coalesce_key(payload: dict[str, Any]) -> str | None:
    """Key for coalescing burst inject events (keep latest per subtask + type)."""
    t = str(payload.get("type") or "").strip().lower()
    if t not in {"task_running", "task_started", "task_completed", "task_failed", "task_timed_out"}:
        return None
    sub = str(payload.get("collab_subtask_id") or payload.get("collabSubtaskId") or "").strip()
    task = str(payload.get("task_id") or payload.get("taskId") or "").strip()
    return f"{t}:{sub or task or 'main'}"


def _compact_inject_queue(q: asyncio.Queue[dict[str, Any]], incoming: dict[str, Any]) -> None:
    """Drain queue, coalesce subtask status frames, re-enqueue with incoming (cap maxsize)."""
    items: list[dict[str, Any]] = [incoming]
    while True:
        try:
            item = q.get_nowait()
        except asyncio.QueueEmpty:
            break
        if isinstance(item, dict):
            items.append(item)
    by_key: dict[str, dict[str, Any]] = {}
    rest: list[dict[str, Any]] = []
    for item in items:
        key = _coalesce_key(item)
        if key:
            by_key[key] = item
        else:
            rest.append(item)
    merged = rest + list(by_key.values())
    cap = max(1, q.maxsize)
    for item in merged[-cap:]:
        q.put_nowait(item)


def _notify_middle_layer_inject(thread_id: str) -> None:
    try:
        from app.gateway.streaming.stream_middle_layer import wake_middle_layer_inject

        wake_middle_layer_inject(thread_id)
    except Exception:
        logger.debug("middle layer inject wake failed thread=%s", thread_id, exc_info=True)


async def inject_langgraph_custom(thread_id: str, data: dict[str, Any]) -> bool:
    """Queue a subtask custom payload for the live ``runs/stream`` proxy."""
    tid = str(thread_id or "").strip()
    if not tid or not isinstance(data, dict):
        return False
    q = _inject_queues.get(tid)
    if q is None:
        return False
    payload = dict(data)
    try:
        q.put_nowait(payload)
    except asyncio.QueueFull:
        try:
            _compact_inject_queue(q, payload)
        except asyncio.QueueFull:
            logger.warning(
                "session_stream_inject queue full after compact thread=%s type=%s",
                tid,
                payload.get("type"),
            )
            return False
    _invalidate_collab_pending_cache(tid)
    try:
        from evoflow.collab.subtask_stream_trace import stream_debug

        sub = str(payload.get("collab_subtask_id") or payload.get("collabSubtaskId") or "").strip()
        stream_debug(
            "session_inject_ok thread=%s type=%s sub=%s",
            tid,
            str(payload.get("type") or "").strip() or "-",
            sub or "-",
        )
    except Exception:
        pass
    _notify_middle_layer_inject(tid)
    return True


async def inject_evf_frame(thread_id: str, payload: dict[str, Any]) -> bool:
    """Queue a pre-normalized ``evf`` payload for the live ``runs/stream`` proxy."""
    tid = str(thread_id or "").strip()
    if not tid or not isinstance(payload, dict):
        return False
    q = _inject_queues.get(tid)
    if q is None:
        return False
    frame = {"__evf__": dict(payload)}
    try:
        q.put_nowait(frame)
    except asyncio.QueueFull:
        try:
            _compact_inject_queue(q, frame)
        except asyncio.QueueFull:
            logger.warning("session_stream_inject evf queue full thread=%s", tid)
            return False
    try:
        from app.gateway.routers.events import broadcaster

        await broadcaster.broadcast(tid, "agent:evf", dict(payload))
    except Exception:
        pass
    _invalidate_collab_pending_cache(tid)
    _notify_middle_layer_inject(tid)
    return True


def schedule_inject_evf_frame(thread_id: str, payload: dict[str, Any]) -> None:
    async def _go() -> None:
        await inject_evf_frame(thread_id, payload)

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_go(), name="inject_evf_frame")
    except RuntimeError:
        logger.debug("schedule_inject_evf_frame skipped (no loop) thread=%s", thread_id)


async def merge_normalized_with_inject(
    normalized: AsyncIterator[bytes],
    thread_id: str,
    *,
    poll_seconds: float = _DEFAULT_UPSTREAM_POLL_S,
    tail_poll_seconds: float = _DEFAULT_TAIL_POLL_S,
) -> AsyncIterator[bytes]:
    """Interleave UI ``evf`` bytes with queued subtask custom frames (after normalize).

    After the upstream LangGraph stream ends, enters a *tail* phase that keeps polling
    the inject queue *and* checking whether the collab phase is still ``executing`` /
    ``running``.  As long as subtasks are pending, the stream stays open so follow-up
    DAG waves (subtask 2, 3, …) are forwarded to the frontend over the same SSE
    connection.

    Do **not** use ``asyncio.wait_for`` on ``__anext__`` — timeout cancels the pending
    read and may abort ``normalize_langgraph_sse_stream`` before ``finish()`` / ``run_end``.
    """
    tid = str(thread_id or "").strip()
    upstream_iter = normalized.__aiter__()
    pending: asyncio.Task[bytes] | None = None

    from evoflow.observability.poll_loop_log import log_poll_loop_end, log_poll_loop_start, log_poll_tick

    log_poll_loop_start("sse_merge_inject", thread_id=tid, poll_s=poll_seconds, tail_poll_s=tail_poll_seconds)

    def _schedule_next() -> asyncio.Task[bytes]:
        return asyncio.create_task(upstream_iter.__anext__())

    upstream_alive = True
    tail_start: float | None = None
    silent_polls = 0

    try:
        while True:
            log_poll_tick(
                "sse_merge_inject",
                key=tid,
                interval_s=30.0,
                phase="upstream" if upstream_alive else "tail",
                silent_polls=silent_polls,
            )
            for frame in drain_inject_evf_frames(tid):
                yield frame
                silent_polls = 0
                # Reset safety timer — new events mean the stream is still alive.
                if not upstream_alive:
                    tail_start = time.monotonic()

            if pending is None:
                if upstream_alive:
                    pending = _schedule_next()
                else:
                    # Upstream done — keep polling inject queue as long as
                    # collab phase has pending subtasks.
                    if not await _has_pending_collab_subtasks_async(tid):
                        break
                    if tail_start is None:
                        tail_start = time.monotonic()
                    elif time.monotonic() - tail_start > _TAIL_IDLE_MAX_S and not _inject_queue_has_pending(tid):
                        logger.info(
                            "merge_normalized_with_inject tail idle timeout thread=%s (%.0fs, no inject/subtasks)",
                            tid,
                            _TAIL_IDLE_MAX_S,
                        )
                        break
                    elif time.monotonic() - tail_start > _TAIL_PHASE_MAX_S:
                        logger.info(
                            "merge_normalized_with_inject tail timeout thread=%s (%.0fs)",
                            tid,
                            _TAIL_PHASE_MAX_S,
                        )
                        break
                    await asyncio.sleep(tail_poll_seconds)
                    continue

            done, _ = await asyncio.wait({pending}, timeout=poll_seconds, return_when=asyncio.FIRST_COMPLETED)
            if not done:
                silent_polls += 1
                # Extra backoff during long upstream silence (model thinking / slow tools).
                if silent_polls >= 4:
                    await asyncio.sleep(min(0.4, poll_seconds * silent_polls * 0.05))
                continue

            try:
                chunk = pending.result()
            except StopAsyncIteration:
                # Upstream stream ended — enter tail phase.
                upstream_alive = False
                pending = None
                silent_polls = 0
                continue
            pending = None
            silent_polls = 0
            yield chunk
    finally:
        log_poll_loop_end("sse_merge_inject", thread_id=tid, phase="upstream" if upstream_alive else "tail")
        if pending is not None and not pending.done():
            pending.cancel()
            try:
                await pending
            except (asyncio.CancelledError, StopAsyncIteration):
                pass
            except Exception:
                pass

    # Final drain before exit.
    for frame in drain_inject_evf_frames(tid):
        yield frame
