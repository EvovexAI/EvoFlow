"""Apply background tool-summary results from shaped_tool_cache into checkpoint messages."""

from __future__ import annotations

import logging
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.runtime import Runtime

from evoflow.context.shaped_tool_cache import get_shaped
from evoflow.context.tool_result_summarizer import is_already_shaped

logger = logging.getLogger(__name__)


def _thread_id_from_runtime(runtime: Runtime) -> str:
    ctx = getattr(runtime, "context", None) or {}
    if isinstance(ctx, dict):
        for key in ("thread_id", "session_key"):
            val = ctx.get(key)
            if val:
                return str(val).strip()
    try:
        from langgraph.config import get_config

        tid = str(get_config().get("configurable", {}).get("thread_id") or "").strip()
        if tid:
            return tid
    except Exception:
        pass
    return "default"


def apply_shaped_cache_to_messages(messages: list, *, thread_id: str) -> list | None:
    """Upgrade ToolMessage bodies when a background summary is ready."""
    tid = str(thread_id or "").strip()
    if not tid or not messages:
        return None

    out: list = []
    changed = False
    for msg in messages:
        if not isinstance(msg, ToolMessage):
            out.append(msg)
            continue
        cid = str(msg.tool_call_id or "").strip()
        if not cid:
            out.append(msg)
            continue
        cached = get_shaped(tid, cid)
        current = str(msg.content or "")
        if cached and cached != current and is_already_shaped(cached) and (not is_already_shaped(current) or len(cached) > len(current)):
            # Preserve the original message id so the LangGraph ``add_messages``
            # reducer treats this as an in-place replacement. Building a new
            # ToolMessage without ``id=msg.id`` makes the reducer mint a fresh
            # UUID and *append* it, leaving the unshaped duplicate behind.
            out.append(
                ToolMessage(
                    content=cached,
                    tool_call_id=msg.tool_call_id,
                    name=getattr(msg, "name", None),
                    status=getattr(msg, "status", None),
                    id=getattr(msg, "id", None),
                )
            )
            changed = True
        else:
            out.append(msg)

    return out if changed else None


class ToolShapedCacheApplyMiddleware(AgentMiddleware[AgentState]):
    """Merge debounced tool-summary LLM output into messages before the main model runs."""

    state_schema = AgentState

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        messages = state.get("messages") or []
        if not isinstance(messages, list) or not messages:
            return None
        thread_id = _thread_id_from_runtime(runtime)
        patched = apply_shaped_cache_to_messages(messages, thread_id=thread_id)
        if patched is None:
            return None
        return {"messages": patched}

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:  # noqa: ARG002
        return None
