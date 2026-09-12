"""Cap subagent model rounds (``max_turns``) separately from LangGraph ``recursion_limit``."""

from __future__ import annotations

import logging

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage
from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)

_HARD_STOP_MSG = (
    "[STEP_LIMIT_REACHED] 已达到本轮最大推理轮次。\n"
    "请立即调用 `subtask_outcome_report` 上报当前状态：\n"
    "- 如果目标已达成 → outcome=\"completed\"，summary 写清产出路径和验收结论\n"
    "- 如果无法继续 → outcome=\"blocked\"，summary 写清阻塞原因\n"
    "- 如果部分完成 → outcome=\"completed\"（已完成的部分）或 outcome=\"blocked\"（无法完成的部分）\n"
    "不要再调用其他工具，直接调用 `subtask_outcome_report` 结束。"
)


class SubagentTurnLimitMiddleware(AgentMiddleware[AgentState]):
    """Strip tool calls after ``max_turns`` AIMessage rounds (semantic turn cap)."""

    def __init__(self, max_turns: int):
        super().__init__()
        self.max_turns = max(1, int(max_turns))

    def _apply(self, state: AgentState) -> dict[str, list[AIMessage]] | None:
        messages = state.get("messages") or []
        if not messages:
            return None
        ai_rounds = sum(1 for m in messages if isinstance(m, AIMessage))
        if ai_rounds < self.max_turns:
            return None
        last = messages[-1]
        if not isinstance(last, AIMessage):
            return None
        tool_calls = getattr(last, "tool_calls", None) or []
        if not tool_calls:
            return None
        logger.warning(
            "SubagentTurnLimit: ai_rounds=%d max_turns=%d — stripping %d tool_calls",
            ai_rounds,
            self.max_turns,
            len(tool_calls),
        )
        content = str(last.content or "")
        if _HARD_STOP_MSG not in content:
            content = f"{content}\n\n{_HARD_STOP_MSG}".strip()
        stripped = last.model_copy(update={"tool_calls": [], "content": content})
        return {"messages": [stripped]}

    @override
    def after_model(self, state: AgentState, runtime: Runtime) -> dict[str, list[AIMessage]] | None:
        return self._apply(state)

    @override
    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict[str, list[AIMessage]] | None:
        return self._apply(state)
