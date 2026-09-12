"""Per-thread CDP URLs for EvoPanel embedded WebView2 browser panels."""

from __future__ import annotations

import logging
import threading
import time

from evoflow.tools.builtins.browser_screenshot_store import _safe_thread_segment

logger = logging.getLogger(__name__)

_CDP_TTL_SEC = float(__import__("os").getenv("EVOFLOW_BROWSER_EMBED_CDP_TTL", "3600"))

_registry: dict[str, tuple[str, float]] = {}
_lock = threading.Lock()


def set_thread_cdp_url(thread_id: str, cdp_url: str) -> None:
    key = _safe_thread_segment(thread_id)
    url = str(cdp_url or "").strip()
    if not key or not url:
        return
    with _lock:
        _registry[key] = (url, time.time())
    logger.info("browser embed cdp registered thread=%s", key)


def clear_thread_cdp_url(thread_id: str) -> None:
    key = _safe_thread_segment(thread_id)
    if not key:
        return
    with _lock:
        _registry.pop(key, None)
    logger.info("browser embed cdp cleared thread=%s", key)


def get_thread_cdp_url(thread_id: str) -> str:
    key = _safe_thread_segment(thread_id)
    if not key:
        return ""
    now = time.time()
    with _lock:
        hit = _registry.get(key)
        if not hit:
            return ""
        url, ts = hit
        if now - ts > _CDP_TTL_SEC:
            _registry.pop(key, None)
            return ""
        return url
