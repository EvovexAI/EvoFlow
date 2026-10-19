"""Gate memory prompt blocks and the ``assets`` tool via ``runtime.context.memory_enabled``.

Entity Asset Hub writes (experience / process / reflection / preferences) go through
``assets``. The session memory toggle therefore controls both injection and tool binding
for main chat and employee chat.
"""

from __future__ import annotations

import logging
from typing import Any

try:
    from typing import override
except ImportError:  # pragma: no cover
    from typing_extensions import override  # type: ignore

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest
from langchain_core.messages import SystemMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest

from evoflow.agents.memory.runtime_overrides import (
    ASSETS_TOOL_NAME,
    effective_assets_tool_enabled,
    effective_memory_injection_enabled,
    strip_memory_xml_blocks,
)

logger = logging.getLogger(__name__)


def _tool_name(tool: Any) -> str:
    return str(getattr(tool, "name", "") or "").strip()


def _load_assets_tool() -> Any | None:
    try:
        from evoflow.tools.tools import get_builtin_tools

        for t in get_builtin_tools():
            if _tool_name(t) == ASSETS_TOOL_NAME:
                return t
    except Exception:
        logger.debug("load assets tool for memory gate failed", exc_info=True)
    try:
        import importlib

        mod = importlib.import_module("evoflow.tools.builtins.assets_tool")
        return getattr(mod, "assets_tool", None)
    except Exception:
        logger.debug("import assets tool for memory gate failed", exc_info=True)
        return None


class MemoryRuntimeControlMiddleware(AgentMiddleware[AgentState]):
    """Honors memory flags: strip prompt blocks when off; bind/unbind ``assets`` each turn."""

    state_schema = AgentState

    def _patch_system(self, request: ModelRequest) -> ModelRequest:
        rt = getattr(request, "runtime", None)
        if effective_memory_injection_enabled(rt):
            return request
        sm = request.system_message
        if sm is None:
            return request
        content = getattr(sm, "content", "") or ""
        if isinstance(content, list):
            return request
        text = str(content)
        lowered = text.lower()
        if not any(
            marker in lowered
            for marker in (
                "<memory_assets",
                "<memory",
                "<memory_policy",
                "<entity_assets",
                "<person_memory",
                "<workspace_memory",
            )
        ):
            return request
        cleaned = strip_memory_xml_blocks(text)
        if not cleaned.strip():
            return request
        if cleaned == text:
            return request
        patched = sm.model_copy(update={"content": cleaned}) if isinstance(sm, SystemMessage) else SystemMessage(content=cleaned)
        return request.override(system_message=patched)

    def _patch_tools(self, request: ModelRequest) -> ModelRequest:
        rt = getattr(request, "runtime", None)
        tools = list(request.tools or [])
        has_assets = any(_tool_name(t) == ASSETS_TOOL_NAME for t in tools)
        enabled = effective_assets_tool_enabled(rt)

        if not enabled:
            if not has_assets:
                return request
            filtered = [t for t in tools if _tool_name(t) != ASSETS_TOOL_NAME]
            logger.debug("memory_enabled=off: hid assets tool from model binding")
            return request.override(tools=filtered)

        if has_assets:
            return request
        asset = _load_assets_tool()
        if asset is None:
            logger.warning("memory_enabled=on but assets tool unavailable to force-mount")
            return request
        logger.debug("memory_enabled=on: force-mounted assets tool")
        return request.override(tools=[*tools, asset])

    def _patch(self, request: ModelRequest) -> ModelRequest:
        return self._patch_tools(self._patch_system(request))

    @override
    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return handler(self._patch(request))

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return await handler(self._patch(request))

    def _reject_assets_if_disabled(self, request: ToolCallRequest) -> ToolMessage | None:
        name = str((request.tool_call or {}).get("name") or "").strip()
        if name != ASSETS_TOOL_NAME:
            return None
        rt = getattr(request, "runtime", None)
        if effective_assets_tool_enabled(rt):
            return None
        tcid = str((request.tool_call or {}).get("id") or "")
        return ToolMessage(
            content=(
                "assets tool is disabled because memory is off for this session "
                "(memory_enabled=false or config.memory.enabled=false). "
                "Turn memory on in the chat menu to write experience/preferences."
            ),
            tool_call_id=tcid,
            name=ASSETS_TOOL_NAME,
            status="error",
        )

    @override
    def wrap_tool_call(self, request: ToolCallRequest, handler):
        rejected = self._reject_assets_if_disabled(request)
        if rejected is not None:
            return rejected
        return handler(request)

    @override
    async def awrap_tool_call(self, request: ToolCallRequest, handler):
        rejected = self._reject_assets_if_disabled(request)
        if rejected is not None:
            return rejected
        return await handler(request)
