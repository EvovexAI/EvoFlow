"""Agent middleware: sanitize messages before each LLM call (orphan tool pairs, etc.).

Operates on ``request.messages`` (LangChain BaseMessage), not OpenAI wire dicts.
The older :class:`PreCallGuardrail` path expected ``role``/``tool_calls`` at the
top level; ``messages_to_dict`` uses ``type``/``data``, so that path dropped or
skipped repairs and Volc Ark could still 400 with ``11148`` tool-pair mismatch.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest

from evoflow.agents.middlewares.dangling_tool_call_middleware import sanitize_tool_call_pairs

logger = logging.getLogger(__name__)


class PreCallGuardrailAgentMiddleware(AgentMiddleware[AgentState]):
    """Re-run tool-pair sanitize on ``request.messages`` closest to the model call."""

    def __init__(self, max_concurrent_calls: int = 5) -> None:
        super().__init__()
        # Kept for API compatibility with previous constructor; pair sanitize is primary.
        self.max_concurrent_calls = max_concurrent_calls

    def _patch_request(self, request: ModelRequest) -> ModelRequest:
        messages = list(request.messages or [])
        if not messages:
            return request
        try:
            patched = sanitize_tool_call_pairs(messages)
            if patched is None:
                return request
            return request.override(messages=patched)
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


class PostCompactionToolPairSanitizeMiddleware(PreCallGuardrailAgentMiddleware):
    """Same sanitize as PreCall, mounted *after* ContextCompactionMiddleware.

    ``create_agent`` rejects duplicate middleware ``.name`` (defaults to class name),
    so this subclass exists solely to allow a second pass after the fold without
    colliding with the early PreCall in ``build_lead_runtime_middlewares``.
    """
