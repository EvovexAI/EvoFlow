"""Append LRU tool-result path refs as an ephemeral HumanMessage (not system).

Live refs change as tools write large outputs; injecting into ``system_message`` busts
prefix cache. Mirror mind_map: named HumanMessage tail only.
"""

from __future__ import annotations

from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage

from evoflow.context.context_ref_lru import refs_footer

_CONTEXT_REFS_MESSAGE_NAME = "session_context_refs"


def _is_context_refs_message(msg: Any) -> bool:
    return isinstance(msg, (SystemMessage, HumanMessage, ToolMessage)) and getattr(
        msg, "name", None
    ) == _CONTEXT_REFS_MESSAGE_NAME


def _strip_context_refs_messages(messages: list[Any]) -> list[Any]:
    return [m for m in messages if not _is_context_refs_message(m)]


def _messages_from_request(request: ModelRequest) -> list[BaseMessage]:
    from evoflow.agents.middlewares.model_request_messages import messages_from_model_request

    return messages_from_model_request(request)


def _strip_context_refs_from_system(text: str) -> str:
    import re

    out = re.sub(r"<context_refs>[\s\S]*?</context_refs>\s*", "\n", str(text or ""), flags=re.IGNORECASE)
    return re.sub(r"\n{3,}", "\n\n", out).rstrip()


class ContextRefsFooterMiddleware(AgentMiddleware[AgentState]):
    state_schema = AgentState

    def _patch_request(self, request: ModelRequest) -> ModelRequest:
        ctx = getattr(request.runtime, "context", None) or {}
        tid = str(ctx.get("thread_id") or "").strip()
        messages = _strip_context_refs_messages(_messages_from_request(request))

        sm = request.system_message
        if sm is not None:
            raw = str(getattr(sm, "content", "") or "")
            if isinstance(getattr(sm, "content", None), str) is False and not isinstance(raw, str):
                raw = str(sm.content or "")
            base = _strip_context_refs_from_system(raw if isinstance(raw, str) else str(raw or ""))
            content = sm.content if isinstance(sm.content, str) else str(sm.content or "")
            if base != content.rstrip():
                request = request.override(system_message=sm.model_copy(update={"content": base}))

        block = refs_footer(tid) if tid else ""
        if not block or not messages:
            if len(messages) != len(_messages_from_request(request)):
                return request.override(messages=messages)
            return request

        hint = HumanMessage(content=block.strip(), name=_CONTEXT_REFS_MESSAGE_NAME)
        return request.override(messages=[*messages, hint])

    @override
    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return handler(self._patch_request(request))

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return await handler(self._patch_request(request))
