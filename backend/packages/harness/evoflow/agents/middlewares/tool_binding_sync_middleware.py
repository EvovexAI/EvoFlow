"""Sync ``loaded_deferred_tools`` checkpoint channel with per-scenario session persistence."""

from __future__ import annotations

import logging

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware

from evoflow.agents.thread_state import EVF_REPLACE_LOADED_DEFERRED_MARKER

logger = logging.getLogger(__name__)


class ToolBindingSyncMiddleware(AgentMiddleware[AgentState]):
    """Restore / persist deferred tool bindings per session + scenario before each model call."""

    state_schema = AgentState

    @override
    def before_model(self, state: AgentState, runtime) -> dict[str, object] | None:
        from evoflow.session_tool_binding.service import (
            resolve_chat_session_key,
            resolve_thread_id_from_runtime,
            sync_loaded_deferred_state,
        )
        from evoflow.tools.builtins.scenario_activation import get_activated_scenarios

        session_key = resolve_chat_session_key()
        if not session_key:
            return None
        active = get_activated_scenarios() or []
        raw = state.get("loaded_deferred_tools") if isinstance(state, dict) else None
        current = [str(x).strip() for x in (raw or []) if str(x or "").strip()] if isinstance(raw, list) else []
        tid = ""
        try:
            ctx = getattr(runtime, "context", None) if runtime is not None else None
            if isinstance(ctx, dict):
                tid = str(ctx.get("thread_id") or ctx.get("threadId") or "").strip()
        except Exception:
            tid = ""
        if not tid:
            tid = resolve_thread_id_from_runtime()

        try:
            aligned = sync_loaded_deferred_state(
                session_key=session_key,
                active_scenarios=active,
                state_loaded=current,
                thread_id=tid or None,
            )
        except Exception as exc:
            logger.warning("[ToolBindingSync] skip sync (schema/db): %s", exc, exc_info=True)
            return None
        if aligned is None:
            return None
        return {"loaded_deferred_tools": [EVF_REPLACE_LOADED_DEFERRED_MARKER, *aligned]}

    @override
    async def abefore_model(self, state: AgentState, runtime) -> dict[str, object] | None:
        return self.before_model(state, runtime)
