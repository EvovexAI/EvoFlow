"""Persist model-bound context fill snapshots on ``evoflow_chat_sessions.context_json``."""

from __future__ import annotations

import logging
import time
from typing import Any

logger = logging.getLogger(__name__)


def build_context_usage_snapshot(
    *,
    used_tokens: int,
    window_tokens: int,
    message_count: int,
    before_tokens: int | None = None,
    compacted: bool = False,
    note: str = "",
    system_tokens: int | None = None,
    tools_tokens: int | None = None,
    message_tokens: int | None = None,
    tool_count: int | None = None,
    api_active_tokens: int | None = None,
) -> dict[str, Any]:
    """Build UI + persist snapshot.

    Breakdown mirrors DeepSeek token-meter ``contextBreakdown``:
    - ``system_tokens``: system prompt (skills catalog lives here)
    - ``tools_tokens``: bound tool schemas
    - ``message_tokens``: conversation history / surface
    Occupancy numerator stays ``used_tokens`` (gate or provider input).

    ``api_active_tokens`` is the native-style last-turn active context size
    (provider ``total_tokens``, else input+output) used for compaction triggers.
    """
    used = max(0, int(used_tokens))
    window = max(1, int(window_tokens))
    pct = round(used / window * 100.0, 1) if window > 0 else 0.0
    snap: dict[str, Any] = {
        "used_tokens": used,
        "window_tokens": window,
        "message_count": max(0, int(message_count)),
        "pct": pct,
        "compacted": bool(compacted),
        "note": note or "",
        "updated_at_ms": int(time.time() * 1000),
    }
    if before_tokens is not None and int(before_tokens) > used:
        snap["before_tokens"] = max(0, int(before_tokens))
    if system_tokens is not None and int(system_tokens) >= 0:
        snap["system_tokens"] = max(0, int(system_tokens))
    if tools_tokens is not None and int(tools_tokens) >= 0:
        snap["tools_tokens"] = max(0, int(tools_tokens))
    if message_tokens is not None and int(message_tokens) >= 0:
        snap["message_tokens"] = max(0, int(message_tokens))
    if tool_count is not None and int(tool_count) >= 0:
        snap["tool_count"] = max(0, int(tool_count))
    if api_active_tokens is not None and int(api_active_tokens) > 0:
        snap["api_active_tokens"] = max(0, int(api_active_tokens))
    return snap


def load_session_context_usage(session_key: str) -> dict[str, Any] | None:
    """Return persisted ``context_usage`` snapshot for a session, if any."""
    sk = str(session_key or "").strip()
    if not sk:
        return None
    try:
        from evoflow.persistence.session_repositories import get_session_context_for_run_config

        ctx = get_session_context_for_run_config(sk)
        snap = ctx.get("context_usage") if isinstance(ctx, dict) else None
        return snap if isinstance(snap, dict) else None
    except Exception:
        logger.debug("load session context_usage failed session=%s", sk[:24], exc_info=True)
        return None


def load_last_observed_active_tokens(session_key: str) -> int:
    """Last provider ``total_tokens`` (runtime ``last_token_usage.total_tokens``).

    Only ``api_active_tokens`` counts — never fall back to UI ``used_tokens``
    (that field is input occupancy and is not what runtime gates on).
    """
    snap = load_session_context_usage(session_key)
    if not snap:
        return 0
    api = snap.get("api_active_tokens")
    if isinstance(api, (int, float)) and int(api) > 0:
        return int(api)
    return 0


def persist_session_context_usage(
    session_key: str,
    snapshot: dict[str, Any],
) -> None:
    sk = str(session_key or "").strip()
    if not sk or not isinstance(snapshot, dict):
        return
    try:
        from evoflow.persistence.session_repositories import upsert_session_row

        # Keep last provider-observed active tokens across tiktoken-only emits
        # (model_bound / skip_reason) so the next compaction gate still sees them.
        merged = dict(snapshot)
        if int(merged.get("api_active_tokens") or 0) <= 0:
            prev = load_session_context_usage(sk)
            prev_api = int((prev or {}).get("api_active_tokens") or 0)
            if prev_api > 0:
                merged["api_active_tokens"] = prev_api

        upsert_session_row(sk, context={"context_usage": merged})
    except Exception as exc:
        logger.debug("persist session context_usage failed session=%s: %s", sk[:24], exc)
