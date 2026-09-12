"""In-process LRU cache for text file reads (path + mtime)."""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from pathlib import Path

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_cache: OrderedDict[str, tuple[str, float, int]] = OrderedDict()


def _cache_key(path: Path) -> tuple[str, int] | None:
    try:
        resolved = path.resolve()
        if not resolved.is_file():
            return None
        return str(resolved), int(resolved.stat().st_mtime_ns)
    except OSError:
        return None


def get_cached_text(path: str | Path) -> str | None:
    from evoflow.config.agent_orchestration_config import get_agent_orchestration_config

    cfg = get_agent_orchestration_config().file_read_cache
    if not cfg.enabled:
        return None
    key = _cache_key(Path(path))
    if key is None:
        return None
    cache_id = f"{key[0]}:{key[1]}"
    now = time.time()
    with _lock:
        row = _cache.get(cache_id)
        if row is None:
            return None
        text, stored_at, _mtime = row
        if now - stored_at > cfg.ttl_seconds:
            _cache.pop(cache_id, None)
            return None
        _cache.move_to_end(cache_id)
        return text


def store_cached_text(path: str | Path, text: str) -> None:
    from evoflow.config.agent_orchestration_config import get_agent_orchestration_config

    cfg = get_agent_orchestration_config().file_read_cache
    if not cfg.enabled:
        return
    key = _cache_key(Path(path))
    if key is None:
        return
    cache_id = f"{key[0]}:{key[1]}"
    now = time.time()
    with _lock:
        _cache[cache_id] = (text, now, key[1])
        _cache.move_to_end(cache_id)
        while len(_cache) > cfg.max_entries:
            _cache.popitem(last=False)


def invalidate_path(path: str | Path) -> None:
    try:
        resolved = str(Path(path).resolve())
    except OSError:
        return
    with _lock:
        drop = [k for k in _cache if k.startswith(resolved + ":")]
        for k in drop:
            _cache.pop(k, None)
    if drop:
        logger.debug("file_read_cache: invalidated %d entries for %s", len(drop), resolved)


def clear_file_read_cache() -> None:
    with _lock:
        _cache.clear()
