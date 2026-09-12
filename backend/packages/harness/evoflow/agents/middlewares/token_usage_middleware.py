"""Middleware for logging LLM token usage."""

import logging

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage
from langgraph.runtime import Runtime

from evoflow.agents.middlewares.message_usage_helpers import infer_usage_metadata_for_ai_message

logger = logging.getLogger(__name__)


class TokenUsageMiddleware(AgentMiddleware):
    """Logs token usage from model response usage_metadata and saves it to the message."""

    @override
    def after_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        return self._save_usage(state)

    @override
    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        return self._save_usage(state)

    def _save_usage(self, state: AgentState) -> dict | None:
        messages = state.get("messages", [])
        if not messages:
            return None
        last = messages[-1]
        if not isinstance(last, AIMessage):
            return None
        inferred = infer_usage_metadata_for_ai_message(last)
        if not inferred:
            return None
        updated = last.model_copy(update={"usage_metadata": inferred})
        logger.info(
            "LLM token usage: input=%s output=%s total=%s",
            inferred.get("input_tokens", "?"),
            inferred.get("output_tokens", "?"),
            inferred.get("total_tokens", "?"),
        )
        # Persist normalized usage on the message for checkpoints / ui_messages
        return {"messages": [updated]}
