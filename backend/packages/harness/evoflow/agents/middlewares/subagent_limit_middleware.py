"""Middleware to enforce maximum concurrent subagent tool calls per model response."""

import logging

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.runtime import Runtime

from evoflow.subagents.executor import MAX_CONCURRENT_SUBAGENTS

logger = logging.getLogger(__name__)

# Valid range for max_concurrent_subagents
MIN_SUBAGENT_LIMIT = 2
MAX_SUBAGENT_LIMIT = 5

_NOT_DISPATCHED_MSG = (
    "[not dispatched] Parallel subagent limit ({limit}) reached — this task was NOT created. "
    "Wait for the dispatched tasks to finish, then re-dispatch with subagent/task."
)


def _clamp_subagent_limit(value: int) -> int:
    """Clamp subagent limit to valid range [2, 5]."""
    return max(MIN_SUBAGENT_LIMIT, min(MAX_SUBAGENT_LIMIT, value))


class SubagentLimitMiddleware(AgentMiddleware[AgentState]):
    """Caps excess ``subagent``/``task`` tool calls from a single model response.

    When an LLM generates more than max_concurrent parallel task tool calls in
    one response, excess calls stay in the AIMessage but each is answered with a
    synthetic ``status="error"`` ToolMessage (“未派发”). This is more reliable
    than prompt-based limits, and unlike silently deleting the calls (previous
    behavior), the model actually learns those tasks were never created —
    previously it would plan N tasks and lose track of the surplus ones.

    ToolNode skips tool calls that already carry a ToolMessage result, so the
    kept calls are not executed a second time.
    """

    def __init__(self, max_concurrent: int = MAX_CONCURRENT_SUBAGENTS):
        super().__init__()
        self.max_concurrent = _clamp_subagent_limit(max_concurrent)

    def _truncate_task_calls(self, state: AgentState) -> dict | None:
        messages = state.get("messages", [])
        if not messages:
            return None

        last_msg = messages[-1]
        if getattr(last_msg, "type", None) != "ai":
            return None

        tool_calls = getattr(last_msg, "tool_calls", None)
        if not tool_calls:
            return None

        # Count subagent tool calls (legacy name ``task`` still accepted)
        task_indices = [i for i, tc in enumerate(tool_calls) if str(tc.get("name") or "").strip().lower() in {"subagent", "task"}]
        if len(task_indices) <= self.max_concurrent:
            return None

        # Excess calls: keep them in the AIMessage (faithful history + valid
        # tool_call/result pairing) and answer each with a synthetic error
        # ToolMessage. Calls without an id cannot be answered — drop those from
        # the message instead, or ToolNode would execute them.
        excess_indices = set(task_indices[self.max_concurrent :])
        answered: list[ToolMessage] = []
        droppable: set[int] = set()
        for i in excess_indices:
            tc = tool_calls[i]
            call_id = str(tc.get("id") or "").strip()
            if not call_id:
                droppable.add(i)
                continue
            answered.append(
                ToolMessage(
                    content=_NOT_DISPATCHED_MSG.format(limit=self.max_concurrent),
                    tool_call_id=call_id,
                    name=str(tc.get("name") or "subagent"),
                    status="error",
                )
            )
        kept_calls = [tc for i, tc in enumerate(tool_calls) if i not in droppable]
        if not answered and not droppable:
            return None

        logger.warning(
            "Capped %d excess task tool call(s) with not-dispatched notice (limit: %s)",
            len(answered) + len(droppable),
            self.max_concurrent,
        )

        # Same id triggers replacement of the AIMessage; notes append after it.
        updated_msg = last_msg.model_copy(update={"tool_calls": kept_calls})
        return {"messages": [updated_msg, *answered]}

    @override
    def after_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        return self._truncate_task_calls(state)

    @override
    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        return self._truncate_task_calls(state)
