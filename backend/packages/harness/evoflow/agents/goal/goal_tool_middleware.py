"""Expose ``goal_report`` only during hosted goal runs."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest, ModelResponse

from evoflow.agents.goal.goal_runtime import goal_mode_from_runtime, load_goal_row, resolve_session_key
from evoflow.agents.goal.goal_trace_log import log_goal_trace

logger = logging.getLogger(__name__)

_GOAL_REPORT_TOOL_NAME = "goal_report"


def _tool_name(tool: Any) -> str:
    return str(getattr(tool, "name", "") or "").strip()


class GoalToolMiddleware(AgentMiddleware[AgentState]):
    """Bind ``goal_report`` in hosted goal mode; hide it in normal chat."""

    def __init__(self) -> None:
        super().__init__()
        self._goal_report_tool: Any | None = None
        self._last_bind_logged_sk: str | None = None

    def _goal_report(self) -> Any | None:
        if self._goal_report_tool is not None:
            return self._goal_report_tool
        try:
            from evoflow.tools.builtins.goal_report_tool import goal_report_tool

            self._goal_report_tool = goal_report_tool
            return goal_report_tool
        except Exception:
            logger.debug("goal_report tool import failed", exc_info=True)
            return None

    def _patch_tools(self, request: ModelRequest, runtime: Any) -> ModelRequest:
        tools = list(request.tools or [])
        names = {_tool_name(t) for t in tools}
        goal_tool = self._goal_report()
        in_goal_mode = goal_mode_from_runtime(runtime)
        session_key = resolve_session_key(runtime)

        if in_goal_mode and goal_tool is not None and _GOAL_REPORT_TOOL_NAME not in names:
            tools.append(goal_tool)
            if session_key and session_key != self._last_bind_logged_sk:
                row = load_goal_row(session_key)
                log_goal_trace(
                    "模型调用-挂载工具",
                    session_key=session_key,
                    turn_no=int((row or {}).get("step_count") or 0) or None,
                    max_steps=int((row or {}).get("max_steps") or 0) or None,
                    goal_text=str((row or {}).get("prompt") or ""),
                    decision=f"已绑定 {_GOAL_REPORT_TOOL_NAME} 工具",
                    tool_count=len(tools),
                )
                self._last_bind_logged_sk = session_key
        elif not in_goal_mode:
            before = len(tools)
            tools = [t for t in tools if _tool_name(t) != _GOAL_REPORT_TOOL_NAME]
            if before != len(tools):
                log_goal_trace(
                    "模型调用-隐藏工具",
                    session_key=session_key,
                    decision=f"非目标模式，移除 {_GOAL_REPORT_TOOL_NAME}",
                    level=logging.DEBUG,
                )

        if len(tools) == len(request.tools or []):
            return request
        return request.override(tools=tools)

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelCallResult:
        request = self._patch_tools(request, getattr(request, "runtime", None))
        return handler(request)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelCallResult:
        request = self._patch_tools(request, getattr(request, "runtime", None))
        return await handler(request)
