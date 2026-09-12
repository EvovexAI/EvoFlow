"""Append non-blocking mind-map append reminders on evidence tool results."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

logger = logging.getLogger(__name__)


def _thread_id_from_tool_request(request: ToolCallRequest) -> str:
    try:
        ctx = getattr(request.runtime, "context", None) or {}
        tid = str(ctx.get("thread_id") or "").strip()
        if tid:
            return tid
        from evoflow.agents.lead_agent.runtime_context import runtime_context_mapping

        return str(runtime_context_mapping(request.runtime).get("thread_id") or "").strip()
    except Exception:
        return ""


def _messages_from_request(request: ToolCallRequest) -> list:
    state = request.state if isinstance(request.state, dict) else {}
    return list(state.get("messages") or [])


class MindMapEvidenceHintMiddleware(AgentMiddleware[AgentState]):
    """Remind the model to append mind_map patch_node immediately after evidence returns."""

    def _maybe_append_hints(self, request: ToolCallRequest, result: ToolMessage | Command) -> ToolMessage | Command:
        if not isinstance(result, ToolMessage):
            return result
        tool_name = str(request.tool_call.get("name") or "").strip().lower()
        try:
            from evoflow.exploration_graph.config import get_exploration_graph_config, is_exploration_graph_enabled
            from evoflow.exploration_graph.mind_map_hints import (
                EVIDENCE_TOOLS,
                append_evidence_tool_mind_map_hints,
                sibling_evidence_tool_call_ids,
                sibling_tool_names_for_call,
            )
        except Exception:
            return result

        # Duty/proactive patrols: mind_map is optional — nagging empty-body /
        # "must concurrent mind_map" hints caused empty-board dig loops.
        try:
            from evoflow.agents.automation_runtime import runtime_context_dict, triggered_by_proactive

            if triggered_by_proactive(runtime_context_dict(getattr(request, "runtime", None))):
                return result
        except Exception:
            pass

        cfg = get_exploration_graph_config()
        if not is_exploration_graph_enabled() or not cfg.soft_hints:
            return result
        if tool_name not in EVIDENCE_TOOLS:
            return result

        tool_call_id = str(result.tool_call_id or request.tool_call.get("id") or "").strip()
        messages = _messages_from_request(request)
        batch_names, found = sibling_tool_names_for_call(messages, tool_call_id)
        batch_has_mind_map = "mind_map" in batch_names if found else False
        evidence_ids, evid_found = sibling_evidence_tool_call_ids(messages, tool_call_id)
        is_first_evidence = (not evid_found) or (not evidence_ids) or (evidence_ids[0] == tool_call_id)
        args = request.tool_call.get("args") or {}
        if not isinstance(args, dict):
            args = {}

        out = append_evidence_tool_mind_map_hints(
            result,
            tool_name=tool_name,
            tool_args=args,
            batch_has_mind_map=batch_has_mind_map,
            thread_id=_thread_id_from_tool_request(request),
            is_first_evidence_in_batch=is_first_evidence,
        )
        if out is not result:
            logger.debug(
                "MindMapEvidenceHint: appended hint tool=%s batch_mind_map=%s",
                tool_name,
                batch_has_mind_map,
            )
        return out

    @override
    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        result = handler(request)
        return self._maybe_append_hints(request, result)

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        result = await handler(request)
        return self._maybe_append_hints(request, result)
