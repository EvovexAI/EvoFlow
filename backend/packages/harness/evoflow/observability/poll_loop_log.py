"""Throttled logging for long-running poll / SSE loops (CPU troubleshooting)."""

from __future__ import annotations

import logging
import time
from typing import Any

logger = logging.getLogger(__name__)

_last_tick: dict[str, float] = {}


def _ctx_suffix(ctx: dict[str, Any]) -> str:
    if not ctx:
        return ""
    parts = [f"{k}={v}" for k, v in ctx.items() if v is not None and str(v).strip() != ""]
    return (" " + " ".join(parts)) if parts else ""


def log_poll_loop_start(name: str, **ctx: Any) -> None:
    """Log once when a background poll loop / stream merger starts."""
    logger.info("[poll] %s 开始处理 loop%s", name, _ctx_suffix(ctx))


def log_poll_loop_end(name: str, **ctx: Any) -> None:
    """Log when a poll loop exits."""
    logger.info("[poll] %s 结束处理 loop%s", name, _ctx_suffix(ctx))


def log_poll_tick(
    name: str,
    *,
    key: str = "",
    interval_s: float = 30.0,
    level: int = logging.DEBUG,
    **ctx: Any,
) -> None:
    """Log a poll iteration at most once per ``interval_s`` per ``name:key``.

    默认 DEBUG（root level=INFO 时不落盘）：每 loop 每 tick 一行曾是 INFO，
    task_events_sse 按 thread_id 分 key，实测 1.4 万行/天灌 gateway 日志。
    排查 CPU/调度问题把 EVOFLOW_LOG_LEVEL 调到 debug 即可全量看。
    """
    cache_key = f"{name}:{key or '-'}"
    now = time.monotonic()
    if now - _last_tick.get(cache_key, 0.0) < max(1.0, float(interval_s)):
        return
    _last_tick[cache_key] = now
    logger.log(level, "[poll] %s 开始处理 tick%s", name, _ctx_suffix(ctx))


def reset_poll_loop_log_cache() -> None:
    """Test helper."""
    _last_tick.clear()
