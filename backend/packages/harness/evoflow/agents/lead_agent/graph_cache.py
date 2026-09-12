"""Process-local cache for compiled lead-agent graphs (LangGraph calls ``make_lead_agent`` per run)."""

from __future__ import annotations

import logging
import os
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

_CACHE_LOCK = threading.Lock()
_CACHE: OrderedDict[tuple[Any, ...], Any] = OrderedDict()
_DEFAULT_MAX_ENTRIES = 12


def lead_agent_graph_cache_enabled() -> bool:
    raw = (os.getenv("EVOFLOW_LEAD_AGENT_GRAPH_CACHE") or "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _max_entries() -> int:
    raw = (os.getenv("EVOFLOW_LEAD_AGENT_GRAPH_CACHE_SIZE") or "").strip()
    if raw.isdigit():
        return max(1, int(raw))
    return _DEFAULT_MAX_ENTRIES


@dataclass(frozen=True)
class LeadAgentGraphCacheKey:
    """Stable dimensions for graph structure; per-run context uses ``configurable`` at runtime."""

    model_name: str
    agent_name: str
    thinking_enabled: bool
    reasoning_effort: str | None
    session_mode: str
    is_plan_mode: bool
    subagent_enabled: bool
    max_concurrent_subagents: int
    include_search: bool
    use_virtual_paths: bool
    tools_mode: str | None
    tool_groups: tuple[str, ...]
    tool_whitelist: tuple[str, ...]
    mcp_servers_unrestricted: bool
    mcp_servers: tuple[str, ...]
    skills: tuple[str, ...]
    custom_system_prompt_hash: str
    summarization_enabled: bool
    token_usage_enabled: bool
    mission_state_middleware: bool
    is_bootstrap: bool
    activated_scenarios: tuple[str, ...] = ()
    exploration_graph_enabled: bool = True
    tool_search_enabled: bool = True
    has_tool_search_tool: bool = True
    # Invalidate when api_key / base_url change without restarting the worker.
    credentials_fp: str = ""
    # Bump when compile-time prompt binding changes (invalidates graphs built with placeholders).
    schema_version: int = 14

    def as_tuple(self) -> tuple[Any, ...]:
        """All fields in definition order — new fields auto-included via dataclasses.astuple."""
        from dataclasses import astuple
        return astuple(self)


def get_or_build_lead_agent_graph(
    key: LeadAgentGraphCacheKey,
    builder: Callable[[], Any],
) -> tuple[Any, bool]:
    """Return ``(compiled_graph, cache_hit)``."""
    if not lead_agent_graph_cache_enabled() or key.is_bootstrap:
        return builder(), False

    cache_key = key.as_tuple()
    with _CACHE_LOCK:
        hit = _CACHE.get(cache_key)
        if hit is not None:
            _CACHE.move_to_end(cache_key)
            logger.debug("lead_agent graph cache hit model=%s agent=%s", key.model_name, key.agent_name)
            return hit, True

    graph = builder()
    with _CACHE_LOCK:
        _CACHE[cache_key] = graph
        _CACHE.move_to_end(cache_key)
        while len(_CACHE) > _max_entries():
            _CACHE.popitem(last=False)
    logger.info(
        "lead_agent graph cache miss built model=%s agent=%s (entries=%d)",
        key.model_name,
        key.agent_name,
        len(_CACHE),
    )
    return graph, False


def clear_lead_agent_graph_cache() -> None:
    with _CACHE_LOCK:
        _CACHE.clear()
    _fire_graph_cache_cleared()


_CLEAR_CALLBACKS: list[Callable[[], None]] = []
_CLEAR_CALLBACKS_LOCK = threading.Lock()


def register_lead_agent_graph_cache_cleared(callback: Callable[[], None]) -> None:
    """Register a no-arg callback invoked after the graph cache is cleared (e.g. re-warmup)."""
    if not callable(callback):
        return
    with _CLEAR_CALLBACKS_LOCK:
        if callback not in _CLEAR_CALLBACKS:
            _CLEAR_CALLBACKS.append(callback)


def _fire_graph_cache_cleared() -> None:
    with _CLEAR_CALLBACKS_LOCK:
        cbs = list(_CLEAR_CALLBACKS)
    for cb in cbs:
        try:
            cb()
        except Exception:
            logger.debug("lead-agent graph cache cleared callback failed", exc_info=True)
