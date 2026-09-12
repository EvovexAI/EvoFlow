"""Strip or retain built-in ``<memory>`` system prompt blocks based on ``runtime.context``."""

from __future__ import annotations

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest
from langchain_core.messages import SystemMessage

from evoflow.agents.memory.runtime_overrides import effective_memory_injection_enabled, strip_memory_xml_blocks


class MemoryRuntimeControlMiddleware(AgentMiddleware[AgentState]):
    """Honors ``runtime.context`` memory flags by patching ``request.system_message`` before the model call."""

    state_schema = AgentState

    def _patch(self, request: ModelRequest) -> ModelRequest:
        rt = getattr(request, "runtime", None)
        if effective_memory_injection_enabled(rt):
            return request
        sm = request.system_message
        if sm is None:
            return request
        content = getattr(sm, "content", "") or ""
        if isinstance(content, list):
            # Multipart content: skip (unexpected for lead system prompt)
            return request
        text = str(content)
        if "<memory>" not in text.lower():
            return request
        cleaned = strip_memory_xml_blocks(text)
        if not cleaned.strip():
            return request  # Don't create empty SystemMessage — can cause model empty responses
        if cleaned == text:
            return request
        patched = sm.model_copy(update={"content": cleaned}) if isinstance(sm, SystemMessage) else SystemMessage(content=cleaned)
        return request.override(system_message=patched)

    @override
    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return handler(self._patch(request))

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return await handler(self._patch(request))
