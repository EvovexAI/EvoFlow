"""Inject fresh ``<mission_state>`` as an ephemeral HumanMessage (never into system).

Mission/intent analysis runs asynchronously after the first model reply per user message.
Tool loops may continue while analysis finishes. Putting live mission into ``system_message``
busts prefix cache; mirror mind_map/collab: strip legacy system blocks and append a named
HumanMessage on each ``wrap_model_call`` (not checkpointed).
"""

from __future__ import annotations

import logging
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage

logger = logging.getLogger(__name__)

_MISSION_STATE_MESSAGE_NAME = "session_mission_state"


def _is_mission_state_message(msg: Any) -> bool:
    return isinstance(msg, (SystemMessage, HumanMessage, ToolMessage)) and getattr(
        msg, "name", None
    ) == _MISSION_STATE_MESSAGE_NAME


def _strip_mission_state_messages(messages: list[Any]) -> list[Any]:
    return [m for m in messages if not _is_mission_state_message(m)]


def _messages_from_request(request: ModelRequest) -> list[BaseMessage]:
    from evoflow.agents.middlewares.model_request_messages import messages_from_model_request

    return messages_from_model_request(request)


class MissionStateLiveFooterMiddleware(AgentMiddleware[AgentState]):
    """Reload mission state and inject as message-tail HumanMessage before each model call."""

    state_schema = AgentState

    def _strip_stale_system_mission(self, request: ModelRequest) -> ModelRequest:
        sm = request.system_message
        if sm is None:
            return request
        try:
            from evoflow.agents.lead_agent.prompt import strip_mission_state_from_system_prompt
        except Exception:
            return request
        raw = str(getattr(sm, "content", "") or "")
        base = strip_mission_state_from_system_prompt(raw)
        if base == raw.rstrip():
            return request
        return request.override(system_message=sm.model_copy(update={"content": base}))

    def _patch_request(self, request: ModelRequest) -> ModelRequest:
        try:
            from evoflow.agents.automation_runtime import is_unattended_automation, triggered_by_automation
            from evoflow.agents.lead_agent.prompt import (
                _build_mission_state_section,
                strip_mission_state_from_system_prompt,
            )
            from evoflow.agents.middlewares.dynamic_system_prompt_middleware import _merged_runtime_context
            from evoflow.agents.mission_state.config import (
                MISSION_STATE_ENABLED,
                MISSION_STATE_PROMPT_INJECTION_ENABLED,
            )
            from evoflow.agents.mission_state.storage import load_mission_state
        except Exception:
            return request

        request = self._strip_stale_system_mission(request)
        messages = _strip_mission_state_messages(_messages_from_request(request))

        if not MISSION_STATE_ENABLED or not MISSION_STATE_PROMPT_INJECTION_ENABLED:
            if len(messages) != len(_messages_from_request(request)):
                return request.override(messages=messages)
            return request

        if is_unattended_automation(getattr(request, "runtime", None)):
            if len(messages) != len(_messages_from_request(request)):
                return request.override(messages=messages)
            return request

        ctx = _merged_runtime_context(request)
        if triggered_by_automation(ctx):
            if len(messages) != len(_messages_from_request(request)):
                return request.override(messages=messages)
            return request

        tid = str(ctx.get("thread_id") or "").strip()
        if not tid:
            try:
                from langgraph.config import get_config

                tid = str(get_config().get("configurable", {}).get("thread_id") or "").strip()
            except Exception:
                tid = ""
        if not tid:
            logger.debug("MissionStateLiveFooter: skip (no thread_id in runtime/configurable)")
            if len(messages) != len(_messages_from_request(request)):
                return request.override(messages=messages)
            return request

        # Ensure system never retains a stale block even when we skip injection.
        sm = request.system_message
        if sm is not None:
            raw = str(getattr(sm, "content", "") or "")
            base = strip_mission_state_from_system_prompt(raw)
            if base != raw.rstrip():
                request = request.override(system_message=sm.model_copy(update={"content": base}))

        ms = load_mission_state(tid)
        meta = ctx.get("evf_dynamic_prompt_meta")
        pl = meta.get("prompt_language") if isinstance(meta, dict) else None
        if not pl:
            pl = ctx.get("prompt_language")

        ms_payload = ms.model_dump(mode="json") if ms is not None else None
        section = _build_mission_state_section(ms_payload, prompt_language=pl, thread_id=tid)
        if not section.strip():
            if len(messages) != len(_messages_from_request(request)):
                return request.override(messages=messages)
            return request

        if not messages:
            # Need at least one prior message so the tail is not the sole turn content.
            return request

        version = ms.version if ms is not None else 0
        hint = HumanMessage(content=section.strip(), name=_MISSION_STATE_MESSAGE_NAME)
        logger.debug(
            "MissionStateLiveFooter: injected mission_state HumanMessage thread=%s version=%s",
            tid,
            version,
        )
        return request.override(messages=[*messages, hint])

    @override
    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return handler(self._patch_request(request))

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return await handler(self._patch_request(request))
