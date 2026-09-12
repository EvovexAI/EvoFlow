"""Legacy workspace preflight (disabled: host-direct tools resolve paths without blocking)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command


class WorkspaceGuardMiddleware(AgentMiddleware):
    """No-op: file tools use ``workspace_path_guard`` without preflight blocking."""

    @override
    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        return handler(request)

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        return await handler(request)
