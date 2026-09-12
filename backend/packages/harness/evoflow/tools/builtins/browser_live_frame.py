"""Capture a live browser viewport frame as PNG bytes (polling fallback for EvoPanel)."""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from evoflow.tools.builtins.browser_stream import browser_session_name

logger = logging.getLogger(__name__)

_CACHE_TTL_SEC = float(os.getenv("EVOFLOW_BROWSER_FRAME_CACHE_TTL", "5"))
_FRAME_TIMEOUT_SEC = int(os.getenv("EVOFLOW_BROWSER_FRAME_TIMEOUT", "20"))
_STALE_MAX_SEC = float(os.getenv("EVOFLOW_BROWSER_FRAME_STALE_MAX", "30"))


@dataclass
class _FrameCacheEntry:
    png: bytes | None = None
    updated_at: float = 0.0
    capturing: bool = False


_cache: dict[str, _FrameCacheEntry] = {}
_cache_lock = threading.Lock()
_refresh_scheduled: set[str] = set()


def _cache_key(thread_id: str) -> str:
    from evoflow.tools.builtins.browser_screenshot_store import _safe_thread_segment

    return _safe_thread_segment(thread_id)


def capture_browser_viewport_png(thread_id: str, *, timeout: int | None = None) -> bytes | None:
    from evoflow.tools.builtins.browser_tool import _run_browser_cli

    tmp_path = ""
    cli_timeout = int(timeout or _FRAME_TIMEOUT_SEC)
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp_path = tmp.name
        cli_result = _run_browser_cli(thread_id, ["screenshot", tmp_path], timeout=cli_timeout)
        if cli_result.startswith("Error:"):
            logger.debug("browser live frame capture failed thread=%s: %s", thread_id, cli_result)
            return None
        path = Path(tmp_path)
        if not path.is_file():
            return None
        png_bytes = path.read_bytes()
        return png_bytes or None
    except Exception as exc:
        logger.warning("browser live frame capture error thread=%s: %s", thread_id, exc)
        return None
    finally:
        if tmp_path:
            Path(tmp_path).unlink(missing_ok=True)


def browser_live_frame_api_path(thread_id: str) -> str:
    tid = _cache_key(thread_id)
    return f"/api/threads/{tid}/browser-live-frame"


def _legacy_tool_thread_segment(thread_id: str) -> str:
    """Match historical browser_tool 48-char sanitization for session lookup."""
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in str(thread_id or ""))[:48]
    return safe or "default"


def resolve_browser_thread_candidates(thread_id: str) -> list[str]:
    """Try multiple thread id shapes when resolving an active browser session."""
    from evoflow.tools.builtins.browser_screenshot_store import _safe_thread_segment

    raw = str(thread_id or "").strip()
    if not raw:
        return ["default"]
    safe = _safe_thread_segment(raw)
    legacy = _legacy_tool_thread_segment(raw)
    session = browser_session_name(raw)
    candidates: list[str] = []
    for item in (
        raw,
        safe,
        legacy,
        session.removeprefix("evoflow-") if session.startswith("evoflow-") else "",
    ):
        item = str(item or "").strip()
        if item and item not in candidates:
            candidates.append(item)
    return candidates


def _capture_for_candidates(thread_id: str) -> bytes | None:
    for tid in resolve_browser_thread_candidates(thread_id):
        png = capture_browser_viewport_png(tid)
        if png:
            return png
    return None


def _capture_and_cache(thread_id: str) -> None:
    key = _cache_key(thread_id)
    with _cache_lock:
        entry = _cache.setdefault(key, _FrameCacheEntry())
        if entry.capturing:
            return
        entry.capturing = True
    try:
        png = _capture_for_candidates(thread_id)
    except Exception as exc:
        logger.warning("browser live frame refresh failed thread=%s: %s", thread_id, exc)
        png = None
    finally:
        with _cache_lock:
            entry = _cache.setdefault(key, _FrameCacheEntry())
            entry.capturing = False
            if png:
                entry.png = png
                entry.updated_at = time.time()


def peek_cached_live_frame(thread_id: str) -> bytes | None:
    key = _cache_key(thread_id)
    now = time.time()
    with _cache_lock:
        entry = _cache.get(key)
        if not entry or not entry.png:
            return None
        if now - entry.updated_at > _STALE_MAX_SEC:
            return None
        return entry.png


def should_refresh_live_frame(thread_id: str) -> bool:
    key = _cache_key(thread_id)
    now = time.time()
    with _cache_lock:
        entry = _cache.get(key)
        if entry and entry.capturing:
            return False
        if entry and entry.png and now - entry.updated_at < _CACHE_TTL_SEC:
            return False
        if key in _refresh_scheduled:
            return False
        _refresh_scheduled.add(key)
        return True


def mark_refresh_finished(thread_id: str) -> None:
    _refresh_scheduled.discard(_cache_key(thread_id))


def schedule_live_frame_refresh(loop: asyncio.AbstractEventLoop, thread_id: str) -> None:
    if not should_refresh_live_frame(thread_id):
        return

    async def _job() -> None:
        try:
            await asyncio.to_thread(_capture_and_cache, thread_id)
        finally:
            mark_refresh_finished(thread_id)

    loop.create_task(_job())


def prime_live_frame_cache(thread_id: str) -> None:
    """Warm cache after browser open without blocking the tool call response."""
    key = _cache_key(thread_id)
    with _cache_lock:
        if key in _refresh_scheduled:
            return
        _refresh_scheduled.add(key)

    def _run() -> None:
        try:
            _capture_and_cache(thread_id)
        finally:
            mark_refresh_finished(thread_id)

    threading.Thread(target=_run, name=f"browser-frame-prime-{key[:12]}", daemon=True).start()
