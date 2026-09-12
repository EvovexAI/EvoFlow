"""Strip legacy ``<turn_context>`` blocks from the system prompt (no longer injected)."""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest
from langchain_core.messages import SystemMessage

_TURN_CONTEXT_RE = re.compile(r"<turn_context>[\s\S]*?</turn_context>\s*", re.IGNORECASE)


def _strip_turn_context(content: str) -> str:
    return _TURN_CONTEXT_RE.sub("", content or "").rstrip()


def _patch_request(request: ModelRequest) -> ModelRequest:
    sys_msg = request.system_message
    if sys_msg is None:
        return request
    content = sys_msg.content if isinstance(sys_msg.content, str) else str(sys_msg.content or "")
    base = _strip_turn_context(content)
    if not base.strip():
        return request  # Don't create empty SystemMessage — can cause model empty responses
    if base == content:
        return request
    return request.override(system_message=SystemMessage(content=base))


class TurnContextMiddleware(AgentMiddleware[AgentState]):
    """Remove stale ``<turn_context>`` anchors from cached system prompts."""

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelCallResult],
    ) -> ModelCallResult:
        return handler(_patch_request(request))

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelCallResult]],
    ) -> ModelCallResult:
        return await handler(_patch_request(request))
