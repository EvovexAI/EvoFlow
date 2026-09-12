"""Shared Gateway HTTP observability recording (REST middleware + LangGraph ASGI wrapper)."""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from typing import Any

from evoflow.observability.gateway_paths import normalize_gateway_obs_path

logger = logging.getLogger(__name__)

# In-memory spike detection: (method, normalized_path) -> (window_start, count)
_SPIKE_WINDOW_S = 60.0
_SPIKE_WARN_THRESHOLD = 30
_spike_buckets: dict[tuple[str, str], tuple[float, int]] = defaultdict(lambda: (0.0, 0))
_spike_warned: dict[tuple[str, str], float] = {}


def _occurred_at() -> str:
    try:
        from evoflow.timeutil import beijing_now_iso

        return beijing_now_iso()
    except Exception:
        return ""


def _maybe_log_request_spike(*, method: str, path: str) -> None:
    key = (str(method or "").upper(), normalize_gateway_obs_path(path))
    now = time.monotonic()
    window_start, count = _spike_buckets[key]
    if now - window_start >= _SPIKE_WINDOW_S:
        window_start, count = now, 0
    count += 1
    _spike_buckets[key] = (window_start, count)
    if count < _SPIKE_WARN_THRESHOLD:
        return
    last_warn = _spike_warned.get(key, 0.0)
    if now - last_warn < _SPIKE_WINDOW_S:
        return
    _spike_warned[key] = now
    logger.warning(
        "gateway request spike: %s %s — %d hits in %.0fs (check client retries or stale-thread rebuild)",
        key[0],
        key[1],
        count,
        _SPIKE_WINDOW_S,
    )


def schedule_gateway_observability_record(payload: dict[str, Any]) -> None:
    """Best-effort async write to evoflow_obs_gateway_requests; never raises."""
    method = str(payload.get("method") or "")
    path = str(payload.get("path") or "")
    _maybe_log_request_spike(method=method, path=path)

    async def runner() -> None:
        try:
            from evoflow.observability.recorder import get_observability_recorder

            await asyncio.to_thread(get_observability_recorder().record_gateway_request, **payload)
        except Exception:
            logger.debug("gateway observability record task failed", exc_info=True)

    try:
        asyncio.create_task(runner())
    except RuntimeError:
        logger.debug("gateway observability record task could not be scheduled", exc_info=True)


def build_gateway_obs_payload(
    *,
    method: str,
    path: str,
    status_code: int,
    duration_ms: float,
    query_string: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    meta = dict(metadata or {})
    meta.setdefault("source", "gateway")
    return {
        "occurred_at": _occurred_at(),
        "method": method,
        "path": normalize_gateway_obs_path(path),
        "query_string": query_string or None,
        "client_ip": None,
        "user_agent": None,
        "request_content_type": None,
        "response_content_type": None,
        "status_code": int(status_code),
        "duration_ms": round(float(duration_ms), 2),
        "request_headers": None,
        "response_headers": None,
        "request_body_sample": None,
        "response_body_sample": None,
        "request_body_truncated": False,
        "response_body_truncated": False,
        "error_type": None,
        "metadata": meta,
    }
