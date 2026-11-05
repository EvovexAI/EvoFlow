"""Sort and session-lock ``ModelRequest.tools`` for prefix-cache stability.

After Deferred/PlanGuard/Proactive have decided the visible set, freeze that name
set for the thread and always emit tools in alphabetical order. Mid-session
reorder of the same set would otherwise bust Anthropic/DeepSeek prefix cache.

When upstream **grants new tools** (capability edit / deferred load), expand the
lock so they reach the model. Capability edits also call
``clear_tool_surface_lock`` so a shrink (unbind) is not stuck on the old freeze.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_locked_names_by_thread: dict[str, tuple[str, ...]] = {}


def clear_tool_surface_lock(thread_id: str | None = None) -> None:
    """Drop frozen tool names (one thread, or all when ``thread_id`` is empty)."""
    tid = str(thread_id or "").strip()
    with _lock:
        if not tid:
            _locked_names_by_thread.clear()
            return
        _locked_names_by_thread.pop(tid, None)


def clear_tool_surface_locks_for_threads(thread_ids: list[str] | None) -> int:
    """Clear locks for known session/thread ids. Returns how many were removed."""
    removed = 0
    with _lock:
        for raw in thread_ids or []:
            tid = str(raw or "").strip()
            if tid and tid in _locked_names_by_thread:
                _locked_names_by_thread.pop(tid, None)
                removed += 1
    return removed


def _tool_name(tool: Any) -> str:
    return str(getattr(tool, "name", None) or getattr(tool, "__name__", "") or "").strip()


def _sort_tools(tools: list[Any]) -> list[Any]:
    return sorted(tools, key=lambda t: _tool_name(t).lower())


class ToolSurfaceLockMiddleware(AgentMiddleware[AgentState]):
    """Canonical sort + freeze tool name set per thread after first model-visible bind."""

    state_schema = AgentState

    def _thread_id(self, request: ModelRequest) -> str:
        try:
            from evoflow.agents.middlewares.dynamic_system_prompt_middleware import _merged_runtime_context

            ctx = _merged_runtime_context(request)
            tid = str(ctx.get("thread_id") or "").strip()
            if tid:
                return tid
        except Exception:
            pass
        raw = getattr(getattr(request, "runtime", None), "context", None)
        if isinstance(raw, dict):
            return str(raw.get("thread_id") or "").strip() or "_default"
        return "_default"

    def _patch_request(self, request: ModelRequest) -> ModelRequest:
        tools = list(request.tools or [])
        if not tools:
            return request

        tid = self._thread_id(request)
        by_name: dict[str, Any] = {}
        for t in tools:
            n = _tool_name(t)
            if n and n.lower() not in by_name:
                by_name[n.lower()] = t

        current = tuple(sorted(by_name.keys()))
        with _lock:
            locked = _locked_names_by_thread.get(tid)
            if locked is None:
                _locked_names_by_thread[tid] = current
                locked = current
                logger.debug(
                    "ToolSurfaceLock: freeze thread=%s tools=%d",
                    tid,
                    len(locked),
                )
            else:
                locked_set = set(locked)
                current_set = set(current)
                added = current_set - locked_set
                if added:
                    # Capability grant or deferred load — surface new tools; cache already busts.
                    locked = tuple(sorted(locked_set | current_set))
                    _locked_names_by_thread[tid] = locked
                    logger.info(
                        "ToolSurfaceLock: expand thread=%s +%d (now=%d)",
                        tid,
                        len(added),
                        len(locked),
                    )

        # Intersection: keep locked names that still exist (phase may temporarily hide some).
        kept: list[Any] = []
        for name in locked:
            tool = by_name.get(name)
            if tool is not None:
                kept.append(tool)

        # If the filtered set is empty but request had tools, fall back to sorted current
        # (avoids binding zero tools after a phase wipe) and refresh lock.
        if not kept and by_name:
            kept = _sort_tools(list(by_name.values()))
            with _lock:
                _locked_names_by_thread[tid] = tuple(_tool_name(t).lower() for t in kept)
        else:
            kept = _sort_tools(kept)

        current_names = [_tool_name(t) for t in tools]
        kept_names = [_tool_name(t) for t in kept]
        if current_names == kept_names and tools == kept:
            return request
        return request.override(tools=kept)

    @override
    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return handler(self._patch_request(request))

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return await handler(self._patch_request(request))
