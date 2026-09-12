"""Shared mirror lane: one transform per thread for all LangGraph upstream sources.

Browser POST, upstream drain, and background join all feed **raw LangGraph SSE**
into the same ``PostStreamUiTransform`` (mirror-only).  Decouples mirror writes
from whichever HTTP client is connected.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

logger = logging.getLogger(__name__)

_LOCK = threading.Lock()
_LANES: dict[str, Any] = {}


def _lane_key(thread_id: str) -> str:
    return str(thread_id or "").strip()


def ensure_mirror_lane(
    thread_id: str,
    *,
    body: bytes = b"",
    stream_format: str = "agui",
    run_id: str | None = None,
) -> bool:
    """Create or refresh the mirror-only transform for *thread_id*."""
    tid = _lane_key(thread_id)
    if not tid:
        return False
    from app.gateway.streaming.post_stream_ui_normalize import PostStreamUiTransform

    with _LOCK:
        lane = _LANES.get(tid)
        if lane is None:
            lane = PostStreamUiTransform(
                thread_id=tid,
                body=body,
                stream_format=stream_format if stream_format in {"agui", "openai"} else "agui",
                run_id=run_id,
                mirror_enabled=True,
                mirror_source="mirror-lane",
                mirror_lane_owned=True,
            )
            _LANES[tid] = lane
            return True
        if run_id and str(run_id).strip():
            lane._apply_upstream_run_id(str(run_id).strip())
        return False


def feed_mirror_lane_upstream(
    thread_id: str,
    chunk: bytes | str,
    *,
    source: str = "upstream",
) -> None:
    """Feed raw LangGraph SSE bytes into the shared mirror lane."""
    tid = _lane_key(thread_id)
    if not tid or not chunk:
        return
    with _LOCK:
        lane = _LANES.get(tid)
    if lane is None:
        return
    raw = chunk if isinstance(chunk, (bytes, bytearray)) else str(chunk).encode("utf-8")
    lane.feed_upstream_for_mirror(raw)


def finish_mirror_lane_upstream(thread_id: str) -> None:
    """Flush normalizer tail into mirror after an upstream closes."""
    tid = _lane_key(thread_id)
    if not tid:
        return
    with _LOCK:
        lane = _LANES.pop(tid, None)
    if lane is None:
        return
    try:
        lane.finish_upstream_for_mirror()
    except Exception:
        logger.debug("mirror lane finish failed thread=%s", tid, exc_info=True)


def release_mirror_lane(thread_id: str) -> None:
    """Drop lane without flush (run cancelled / replaced)."""
    tid = _lane_key(thread_id)
    if not tid:
        return
    with _LOCK:
        _LANES.pop(tid, None)


def has_mirror_lane(thread_id: str) -> bool:
    return _lane_key(thread_id) in _LANES
