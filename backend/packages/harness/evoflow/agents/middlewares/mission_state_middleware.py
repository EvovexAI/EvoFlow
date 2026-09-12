from __future__ import annotations

import logging
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.config import get_config
from langgraph.runtime import Runtime

from evoflow.agents.message_analysis_utils import (
    is_real_user_message,
    latest_real_user_turn_key,
)

logger = logging.getLogger(__name__)
_TURN_MARKED: dict[str, str] = {}


def _latest_user_text(messages: list[Any]) -> str:
    for m in reversed(messages):
        if not is_real_user_message(m):
            continue
        c = getattr(m, "content", "")
        if isinstance(c, str):
            return c.strip()
        if isinstance(c, list):
            parts: list[str] = []
            for x in c:
                if isinstance(x, str):
                    parts.append(x)
                elif isinstance(x, dict):
                    t = x.get("text")
                    if isinstance(t, str):
                        parts.append(t)
            return " ".join(parts).strip()
    return ""


def _thread_id_from_runtime(runtime: Runtime) -> str:
    thread_id = runtime.context.get("thread_id") if runtime and runtime.context else None
    if thread_id:
        return str(thread_id).strip()
    cfg = get_config()
    return str(cfg.get("configurable", {}).get("thread_id") or "").strip()



class MissionStateMiddleware(AgentMiddleware[AgentState]):
    """Mark turn start for working_memory read-counting before each model call.

    User-request capture/injection is temporarily disabled (see
    ``user_requests_store.USER_REQUESTS_PROMPT_INJECTION_ENABLED``).
    """

    state_schema = AgentState

    def _maybe_mark_turn_start(self, state: AgentState, runtime: Runtime) -> None:
        """Mark the start of a new user turn in working_memory for turn-scoped read counting."""
        thread_id = _thread_id_from_runtime(runtime)
        if not thread_id:
            return
        messages = list(state.get("messages", []) or [])
        if not messages:
            return
        try:
            user_turn_key = latest_real_user_turn_key(messages)
            if not user_turn_key:
                return
            if _TURN_MARKED.get(thread_id) == user_turn_key:
                return
            _TURN_MARKED[thread_id] = user_turn_key
            from evoflow.context.working_memory import mark_turn_start

            mark_turn_start(thread_id)
        except Exception:
            pass

        try:
            from evoflow.agents.mission_state.user_requests_store import (
                USER_REQUESTS_PROMPT_INJECTION_ENABLED,
                append_user_request,
            )

            if USER_REQUESTS_PROMPT_INJECTION_ENABLED:
                user_text = _latest_user_text(messages)
                if user_text:
                    append_user_request(thread_id, user_text)
        except Exception:
            pass

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        self._maybe_mark_turn_start(state, runtime)
        return None

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        self._maybe_mark_turn_start(state, runtime)
        return None
