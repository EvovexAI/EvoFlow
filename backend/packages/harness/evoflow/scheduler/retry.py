"""Minimal retry / fallback helpers for scheduler IO."""

from __future__ import annotations

import logging
import time

logger = logging.getLogger(__name__)


def retry_read(fn, *, attempts: int = 2, delay_s: float = 0.15) -> str:
    last: str = ""
    for i in range(attempts):
        last = fn()
        if not str(last).startswith("Error:"):
            return last
        if i + 1 < attempts:
            time.sleep(delay_s)
    return last


def search_with_fts_fallback(search_fn, query: str) -> str:
    """Run search; if empty, retry with simplified token."""
    out = search_fn(query)
    if "No index hits" not in out and "Error:" not in out:
        return out
    tokens = [t for t in query.replace("/", " ").split() if len(t) >= 3]
    if not tokens:
        return out
    fallback_q = tokens[0]
    if fallback_q == query:
        return out
    logger.debug("scheduler search FTS fallback: %s -> %s", query, fallback_q)
    return search_fn(fallback_q)
