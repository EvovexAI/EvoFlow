"""Gateway-side SSE wire mirror for chat stream resume (optional).

Default **off** (``EVOFLOW_STREAM_MIRROR=0``): resume polls ``evoflow_chat_messages``
instead of writing this table. Set ``EVOFLOW_STREAM_MIRROR=1`` to re-enable tee writes.

When enabled, primary write path is ``PostStreamUiTransform._mirror_out_frames``;
``enqueue_wire_*`` covers attach / disconnect fallbacks. Writes are batched on the
gateway event loop so the middle-layer pump is not blocked by per-chunk SQLite.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

_FALSE_ENV = frozenset({"0", "false", "no", "off"})

_BATCH_MAX_FRAMES = max(1, int(os.getenv("EVOFLOW_STREAM_MIRROR_BATCH_FRAMES", "48")))
_BATCH_FLUSH_INTERVAL_S = max(
    0.01,
    float(os.getenv("EVOFLOW_STREAM_MIRROR_FLUSH_MS", "75")) / 1000.0,
)


def stream_mirror_writes_enabled() -> bool:
    """Whether to persist SSE frames into ``evoflow_chat_stream_mirror``.

    Default **off**: resume polls chat history instead of the mirror table.
    Re-enable with ``EVOFLOW_STREAM_MIRROR=1``.
    """
    env = (os.getenv("EVOFLOW_STREAM_MIRROR") or "0").strip().lower()
    return env not in _FALSE_ENV


def langgraph_post_mirror_tee_enabled(
    *,
    method: str,
    path: str,
    query: str,
    headers: list[tuple[bytes, bytes]] | None = None,
) -> bool:
    """Whether POST ``/runs/stream`` should tee UI SSE into ``evoflow_chat_stream_mirror``.

    Default-off (history-poll resume). Enable globally with ``EVOFLOW_STREAM_MIRROR=1``,
    or disable per-request with header ``x-evoflow-stream-resume: 0``.
    """
    if not stream_mirror_writes_enabled():
        return False
    for hk, hv in headers or []:
        if hk.decode("latin-1").lower() != "x-evoflow-stream-resume":
            continue
        v = hv.decode("latin-1").strip().lower()
        if v in _FALSE_ENV:
            return False
    if method != "POST" or "/runs/stream" not in path:
        return False
    from app.gateway.streaming.post_stream_ui_normalize import ui_sse_enabled_from_query

    return ui_sse_enabled_from_query(query)


# Per-thread SSE frame assembly buffers (incomplete ``\\n\\n`` boundaries)
_wire_buffers: dict[str, str] = {}
_last_touch_ms: dict[str, float] = {}
_touch_interval_ms = 1000.0

_main_loop: asyncio.AbstractEventLoop | None = None
_batch_lock = threading.Lock()

_TERMINAL_EVENT_RE = re.compile(
    r"(?:^|\n)event:\s*(done|end|error|run_end)\b",
    re.IGNORECASE,
)
_TERMINAL_DATA_RE = re.compile(r"(?:^|\n)data:\s*\[DONE\]", re.IGNORECASE)
_DATA_LINE_RE = re.compile(r"(?:^|\n)data:\s*(.*?)(?=\n[a-zA-Z]+:|\n\n|$)", re.IGNORECASE | re.DOTALL)


@dataclass
class _MirrorBatch:
    session_key: str
    thread_id: str
    run_id: str
    source: str = "mirror"
    frames: list[str] = field(default_factory=list)
    flush_handle: asyncio.TimerHandle | None = None
    flush_task: asyncio.Task[None] | None = None


_pending_batches: dict[str, _MirrorBatch] = {}


def _buffer_key(thread_id: str, run_id: str | None = None) -> str:
    tid = str(thread_id or "").strip()
    # Buffer per thread only — run_id may arrive after the first SSE chunks on POST /runs/stream.
    return tid


def _resolve_session_key(thread_id: str) -> str | None:
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    try:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        return find_session_key_by_thread_id(tid) or None
    except Exception:
        return None


def _resolve_run_id(thread_id: str, run_id: str | None = None) -> str | None:
    rid = str(run_id or "").strip()
    if rid:
        return rid
    try:
        from evoflow.persistence.session_run_state import peek_current_run_id

        return str(peek_current_run_id(thread_id=thread_id) or "").strip() or None
    except Exception:
        return None


def _capture_main_loop() -> asyncio.AbstractEventLoop | None:
    global _main_loop
    try:
        _main_loop = asyncio.get_running_loop()
    except RuntimeError:
        pass
    return _main_loop


def _split_wire_frames(
    thread_id: str,
    chunk: bytes | str,
    *,
    run_id: str | None = None,
) -> list[str]:
    """Split wire bytes into complete SSE frames; keep partial tail in ``_wire_buffers``."""
    tid = str(thread_id or "").strip()
    if not tid or not chunk:
        return []
    text = chunk.decode("utf-8", errors="ignore") if isinstance(chunk, (bytes, bytearray)) else str(chunk)
    if not text:
        return []
    key = _buffer_key(tid, run_id)
    buf = _wire_buffers.get(key, "") + text.replace("\r\n", "\n")
    frames: list[str] = []
    while "\n\n" in buf:
        frame, buf = buf.split("\n\n", 1)
        if frame.strip():
            frames.append(frame + "\n\n")
    _wire_buffers[key] = buf
    return frames


def clear_mirror_for_thread(thread_id: str, *, session_key: str | None = None) -> None:
    tid = str(thread_id or "").strip()
    if tid:
        keys_to_drop = [k for k in _wire_buffers if k == tid or k.startswith(f"{tid}:")]
        for k in keys_to_drop:
            _wire_buffers.pop(k, None)
            _last_touch_ms.pop(k, None)
        _drop_pending_batch(tid)
    sk = str(session_key or "").strip() or None
    if not sk and tid:
        sk = _resolve_session_key(tid)
    if not sk:
        return
    try:
        from evoflow.persistence.stream_mirror_repositories import clear_mirror

        clear_mirror(sk)
    except Exception:
        pass


def _is_terminal_frame(frame: str) -> bool:
    """Detect terminal SSE frame robustly.

    Order:
      1. ``event: done|end|error|run_end`` line  (explicit SSE marker)
      2. ``data: [DONE]``                         (legacy OpenAI marker)
      3. JSON ``data:`` with top-level ``type == "run_end"``

    Falls back to **False** when the data line cannot be JSON-parsed so that
    arbitrary user text containing ``"type":"run_end"`` inside a string does
    not abort the run prematurely.
    """
    text = str(frame or "")
    if not text.strip():
        return False
    if _TERMINAL_EVENT_RE.search(text):
        return True
    if _TERMINAL_DATA_RE.search(text):
        return True
    # Parse the data line(s) as JSON and inspect the *top-level* ``type``.
    match = _DATA_LINE_RE.search(text)
    if not match:
        return False
    data = (match.group(1) or "").strip()
    if not data or not data.startswith("{"):
        return False
    try:
        obj = json.loads(data)
    except (ValueError, TypeError):
        return False
    if isinstance(obj, dict) and str(obj.get("type") or "").strip().lower() == "run_end":
        return True
    return False


def _persist_frames(
    session_key: str,
    thread_id: str,
    run_id: str,
    frames: list[str],
    *,
    source: str = "mirror",
) -> None:
    if not stream_mirror_writes_enabled():
        return
    from evoflow.persistence.db import run_db_transaction
    from evoflow.persistence.stream_mirror_repositories import (
        append_mirror_frame,
        touch_mirror_meta,
    )

    if not frames:
        return

    def _tx(db: Any) -> int | None:
        last_seq: int | None = None
        for frame in frames:
            terminal = _is_terminal_frame(frame)
            last_seq = append_mirror_frame(
                session_key,
                thread_id=thread_id,
                run_id=run_id,
                raw_frame=frame,
                is_terminal=terminal,
                conn=db,
            )
            if last_seq is None:
                logger.debug(
                    "stream mirror persist interrupted session=%s run=%s source=%s",
                    session_key,
                    run_id,
                    source,
                )
                break
        return last_seq

    try:
        last_seq = run_db_transaction(_tx)
    except Exception:
        logger.debug(
            "stream mirror batch persist failed session=%s run=%s source=%s",
            session_key,
            run_id,
            source,
            exc_info=True,
        )
        return

    if last_seq is not None:
        now = time.time() * 1000
        key = _buffer_key(thread_id, run_id)
        if now - _last_touch_ms.get(key, 0) >= _touch_interval_ms:
            try:
                from evoflow.persistence.stream_mirror_repositories import touch_mirror_meta

                touch_mirror_meta(session_key, thread_id=thread_id, run_id=run_id)
            except Exception:
                logger.debug(
                    "stream mirror touch failed session=%s run=%s",
                    session_key,
                    run_id,
                    exc_info=True,
                )
            _last_touch_ms[key] = now


def _drop_pending_batch(key: str) -> None:
    with _batch_lock:
        batch = _pending_batches.pop(key, None)
    if batch is None:
        return
    handle = batch.flush_handle
    if handle is not None:
        handle.cancel()
    task = batch.flush_task
    if task is not None and not task.done():
        task.cancel()


def _drain_pending_batch(key: str) -> tuple[str, str, str, list[str], str] | None:
    with _batch_lock:
        batch = _pending_batches.pop(key, None)
        if batch is None or not batch.frames:
            if batch is not None and batch.flush_handle is not None:
                batch.flush_handle.cancel()
            return None
        if batch.flush_handle is not None:
            batch.flush_handle.cancel()
            batch.flush_handle = None
        frames = batch.frames
        batch.frames = []
        return batch.session_key, batch.thread_id, batch.run_id, frames, batch.source


def _append_frames_to_batch(
    *,
    key: str,
    session_key: str,
    thread_id: str,
    run_id: str,
    frames: list[str],
    source: str,
) -> bool:
    """Append frames; return True when an immediate flush is required."""
    if not frames:
        return False
    has_terminal = any(_is_terminal_frame(frame) for frame in frames)
    with _batch_lock:
        batch = _pending_batches.get(key)
        if batch is None:
            batch = _MirrorBatch(
                session_key=session_key,
                thread_id=thread_id,
                run_id=run_id,
                source=source,
            )
            _pending_batches[key] = batch
        else:
            batch.session_key = session_key
            batch.thread_id = thread_id
            batch.run_id = run_id
            batch.source = source
        batch.frames.extend(frames)
        return has_terminal or len(batch.frames) >= _BATCH_MAX_FRAMES


def _flush_batch_sync(key: str) -> None:
    payload = _drain_pending_batch(key)
    if payload is None:
        return
    sk, tid, rid, frames, source = payload
    _persist_frames(sk, tid, rid, frames, source=source)


async def _flush_batch_async(key: str) -> None:
    payload = _drain_pending_batch(key)
    if payload is None:
        return
    sk, tid, rid, frames, source = payload
    try:
        await asyncio.to_thread(_persist_frames, sk, tid, rid, frames, source=source)
    except Exception:
        logger.debug("stream mirror async flush failed thread=%s run=%s", tid, rid, exc_info=True)


def _ensure_flush_task(key: str) -> None:
    with _batch_lock:
        batch = _pending_batches.get(key)
        if batch is None or not batch.frames:
            return
        if batch.flush_handle is not None:
            batch.flush_handle.cancel()
            batch.flush_handle = None
        if batch.flush_task is not None and not batch.flush_task.done():
            return
        task = asyncio.create_task(_flush_batch_async(key))
        batch.flush_task = task

        def _done(t: asyncio.Task[None]) -> None:
            with _batch_lock:
                current = _pending_batches.get(key)
                if current is not None and current.flush_task is t:
                    current.flush_task = None

        task.add_done_callback(_done)


def _schedule_debounced_flush(key: str) -> None:
    with _batch_lock:
        batch = _pending_batches.get(key)
        if batch is None or not batch.frames:
            return
        if batch.flush_handle is not None:
            return
        loop = asyncio.get_running_loop()
        batch.flush_handle = loop.call_later(_BATCH_FLUSH_INTERVAL_S, lambda: _ensure_flush_task(key))


def _schedule_mirror_flush(key: str, *, immediate: bool) -> None:
    loop = _main_loop
    if loop is None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

    if loop is None or not loop.is_running():
        if immediate:
            _flush_batch_sync(key)
        return

    def _on_loop() -> None:
        if immediate:
            _ensure_flush_task(key)
        else:
            _schedule_debounced_flush(key)

    loop.call_soon_threadsafe(_on_loop)


def _offer_wire_frames(
    thread_id: str,
    chunk: bytes | str,
    *,
    run_id: str | None = None,
    session_key: str | None = None,
    source: str = "mirror",
) -> None:
    tid = str(thread_id or "").strip()
    if not tid or not chunk:
        return

    frames = _split_wire_frames(tid, chunk, run_id=run_id)
    if not frames:
        return

    sk = str(session_key or "").strip() or _resolve_session_key(tid)
    if not sk:
        return
    rid = _resolve_run_id(tid, run_id)
    if not rid:
        return

    key = _buffer_key(tid, run_id)
    flush_now = _append_frames_to_batch(
        key=key,
        session_key=sk,
        thread_id=tid,
        run_id=rid,
        frames=frames,
        source=source,
    )
    _schedule_mirror_flush(key, immediate=flush_now)


def flush_mirror_batch_sync(thread_id: str, *, run_id: str | None = None) -> None:
    """Flush pending mirror frames synchronously (stream end / shrink)."""
    key = _buffer_key(thread_id, run_id)
    with _batch_lock:
        batch = _pending_batches.get(key)
        if batch is not None and batch.flush_handle is not None:
            batch.flush_handle.cancel()
            batch.flush_handle = None
    _flush_batch_sync(key)


async def flush_mirror_batch_for_thread(
    thread_id: str,
    *,
    run_id: str | None = None,
    timeout: float = 5.0,
) -> None:
    """Await pending batched mirror writes for a thread."""
    _capture_main_loop()
    key = _buffer_key(thread_id, run_id)
    with _batch_lock:
        batch = _pending_batches.get(key)
        if batch is not None and batch.flush_handle is not None:
            batch.flush_handle.cancel()
            batch.flush_handle = None
        has_pending = bool(batch and batch.frames)
        in_flight = batch is not None and batch.flush_task is not None and not batch.flush_task.done()

    if not has_pending and not in_flight:
        return

    task = asyncio.create_task(_flush_batch_async(key))
    with _batch_lock:
        batch = _pending_batches.get(key)
        if batch is not None:
            batch.flush_task = task

    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
    except asyncio.TimeoutError:
        logger.warning("stream mirror flush timeout thread=%s", thread_id)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.debug("stream mirror flush failed thread=%s", thread_id, exc_info=True)


async def enqueue_wire_chunk(
    thread_id: str,
    chunk: bytes | str,
    *,
    run_id: str | None = None,
    session_key: str | None = None,
    source: str = "mirror",
) -> None:
    """Append outbound SSE bytes; frames split on ``\\n\\n`` boundaries."""
    if not stream_mirror_writes_enabled():
        return
    _capture_main_loop()
    _offer_wire_frames(
        thread_id,
        chunk,
        run_id=run_id,
        session_key=session_key,
        source=source,
    )


def enqueue_wire_chunk_sync(
    thread_id: str,
    chunk: bytes | str,
    *,
    run_id: str | None = None,
    session_key: str | None = None,
    source: str = "mirror",
) -> None:
    """Fire-and-forget sync wrapper; batches frames and flushes on the gateway loop."""
    if not stream_mirror_writes_enabled():
        return
    _capture_main_loop()
    _offer_wire_frames(
        thread_id,
        chunk,
        run_id=run_id,
        session_key=session_key,
        source=source,
    )


def enqueue_wire_text(
    thread_id: str,
    text: str,
    *,
    run_id: str | None = None,
    session_key: str | None = None,
) -> None:
    enqueue_wire_chunk_sync(thread_id, text, run_id=run_id, session_key=session_key)


def shrink_mirror_for_thread(thread_id: str, *, session_key: str | None = None) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    flush_mirror_batch_sync(tid)
    sk = str(session_key or "").strip() or _resolve_session_key(tid)
    if not sk:
        return
    try:
        from evoflow.persistence.stream_mirror_repositories import shrink_mirror_ttl

        shrink_mirror_ttl(sk)
    except Exception:
        pass
