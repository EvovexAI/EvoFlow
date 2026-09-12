"""local_scheduler mode: execute ``<task_plan>`` from model output instead of tool_calls."""

from __future__ import annotations

import logging
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.runtime import Runtime

from evoflow.config.agent_orchestration_config import is_local_scheduler_mode
from evoflow.scheduler.engine import LocalToolScheduler, format_execution_report_xml
from evoflow.scheduler.task_plan import parse_task_plan_from_text

logger = logging.getLogger(__name__)


def _ai_text(msg: AIMessage) -> str:
    content = getattr(msg, "content", "") or ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "".join(parts)
    return str(content)


class SchedulerOrchestrationMiddleware(AgentMiddleware[AgentState]):
    """After model: if output contains task_plan, run scheduler and strip tool_calls."""

    def _process(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        if not is_local_scheduler_mode():
            return None

        messages = list(state.get("messages") or [])
        if not messages:
            return None
        last = messages[-1]
        if not isinstance(last, AIMessage):
            return None

        text = _ai_text(last)
        plan = parse_task_plan_from_text(text)
        if plan is None:
            return None

        ctx = runtime.context if runtime.context else {}
        root = str(plan.workspace_root or ctx.get("local_workspace_root") or "").strip() or None
        tid = str(ctx.get("thread_id") or "").strip() or None

        sched = LocalToolScheduler(workspace_root=root, thread_id=tid)
        report = sched.run(plan)
        report_xml = format_execution_report_xml(report)

        patched_ai = AIMessage(
            content=text,
            tool_calls=[],
            invalid_tool_calls=[],
            id=getattr(last, "id", None),
        )
        tool_msg = ToolMessage(
            content=report_xml,
            tool_call_id="scheduler-task-plan",
            name="scheduler_execution",
        )
        human_follow = HumanMessage(
            name="execution_report",
            content=report_xml,
        )
        logger.info(
            "local_scheduler executed task_plan ops=%d status=%s",
            len(plan.ops),
            report.status,
        )
        return {"messages": [patched_ai, tool_msg, human_follow]}

    @override
    def after_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._process(state, runtime)

    @override
    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._process(state, runtime)
