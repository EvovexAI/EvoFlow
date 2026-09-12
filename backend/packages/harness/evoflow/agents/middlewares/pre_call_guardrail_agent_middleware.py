"""Agent middleware: sanitize messages before each LLM call (orphan tool pairs, etc.)."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest

from evoflow.agents.middlewares.pre_call_guardrail import PreCallGuardrail

logger = logging.getLogger(__name__)


class PreCallGuardrailAgentMiddleware(AgentMiddleware[AgentState]):
    """Run :class:`PreCallGuardrail` on checkpoint messages before the model sees them."""

    def __init__(self, max_concurrent_calls: int = 5) -> None:
        super().__init__()
        self._guardrail = PreCallGuardrail(max_concurrent_calls=max_concurrent_calls)

    def _patch_request(self, request: ModelRequest) -> ModelRequest:
        state = request.state if isinstance(request.state, dict) else {}
        messages = list(state.get("messages") or [])
        if not messages:
            return request
        try:
            from langchain_core.messages import messages_from_dict, messages_to_dict

            wire = messages_to_dict(messages)
            cleaned = self._guardrail.sanitize(wire)
            if cleaned == wire:
                return request
            new_messages = messages_from_dict(cleaned)
            return request.override(state={**state, "messages": new_messages})
        except Exception:
            logger.debug("PreCallGuardrailAgentMiddleware: sanitize skipped", exc_info=True)
            return request

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelCallResult],
    ) -> ModelCallResult:
        return handler(self._patch_request(request))

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelCallResult]],
    ) -> ModelCallResult:
        return await handler(self._patch_request(request))
