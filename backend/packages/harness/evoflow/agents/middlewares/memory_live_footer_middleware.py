"""Inject frozen standing memory into system; query recall as HumanMessage turn-tail.

Standing MEMORY/USER/workspace blocks are frozen per thread (prefix-cache stable).
Person/craft recall is query-keyed and must not rewrite system mid-session.
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

from evoflow.agents.memory.runtime_overrides import effective_memory_injection_enabled, strip_memory_xml_blocks
from evoflow.agents.memory.standing_freeze import get_frozen_standing_memory

logger = logging.getLogger(__name__)

_MEMORY_RECALL_MESSAGE_NAME = "session_memory_recall"


def _query_recall_enabled() -> bool:
    """Tier 1 turn-tail recall — default off (EVOFLOW_QUERY_RECALL=1 to enable)."""
    try:
        from evoflow.assets.injection_budget import query_recall_enabled

        return query_recall_enabled()
    except Exception:
        return False


def _is_memory_recall_message(msg: Any) -> bool:
    return isinstance(msg, (SystemMessage, HumanMessage, ToolMessage)) and getattr(
        msg, "name", None
    ) == _MEMORY_RECALL_MESSAGE_NAME


def _strip_memory_recall_messages(messages: list[Any]) -> list[Any]:
    return [m for m in messages if not _is_memory_recall_message(m)]


def _messages_from_request(request: ModelRequest) -> list[BaseMessage]:
    from evoflow.agents.middlewares.model_request_messages import messages_from_model_request

    return messages_from_model_request(request)


def _latest_user_query(messages: list[Any]) -> str:
    for msg in reversed(messages):
        role = ""
        content = ""
        if isinstance(msg, dict):
            role = str(msg.get("role") or msg.get("type") or "")
            content = str(msg.get("content") or "")
        else:
            role = str(getattr(msg, "type", None) or getattr(msg, "role", "") or "")
            content = str(getattr(msg, "content", "") or "")
        if role in {"human", "user"} and content.strip():
            if getattr(msg, "name", None) in {
                _MEMORY_RECALL_MESSAGE_NAME,
                "session_mission_state",
                "session_runtime_clock",
                "session_context_refs",
                "session_mind_map",
                "session_collab_live",
            }:
                continue
            return content.strip()[:500]
    return ""


class MemoryLiveFooterMiddleware(AgentMiddleware[AgentState]):
    """Frozen standing memory on system; query recall on message tail."""

    state_schema = AgentState

    def _patch_request(self, request: ModelRequest) -> ModelRequest:
        if not effective_memory_injection_enabled(getattr(request, "runtime", None)):
            return request

        sm = request.system_message
        if sm is None:
            return request

        try:
            from evoflow.agents.lead_agent.intent_tool_profile import ordered_scenario_keys_for_display
            from evoflow.agents.lead_agent.prompt import (
                _enabled_modules_for_scenario,
                _is_pure_chat_modules,
                build_memory_injection_sections,
                build_memory_query_recall_sections,
            )
            from evoflow.agents.middlewares.dynamic_system_prompt_middleware import (
                _merged_runtime_context,
                _resolve_prompt_meta,
            )
            from evoflow.agents.middlewares.plan_guard_middleware import effective_activated_scenario_keys
        except Exception:
            return request

        ctx = _merged_runtime_context(request)
        meta = _resolve_prompt_meta(ctx)
        tid = str(ctx.get("thread_id") or "").strip() or "_default"
        messages = _strip_memory_recall_messages(_messages_from_request(request))
        keys = effective_activated_scenario_keys(request.runtime, messages)
        scen_list = ordered_scenario_keys_for_display(keys)
        intent = ",".join(scen_list) if scen_list else "chat"
        pure_chat = _is_pure_chat_modules(_enabled_modules_for_scenario(intent))
        agent_name = str((meta or {}).get("agent_name") or "main").strip() or "main"
        # Match apply_prompt_template: lead/main always chat_compact for standing memory.
        lead = str(agent_name).strip().lower() in {"", "main", "lead_agent"}
        mem_profile = "chat_compact" if (pure_chat or lead) else "full"

        pl = (meta or {}).get("prompt_language") if isinstance(meta, dict) else None
        if not pl:
            pl = ctx.get("prompt_language")
        lw = (meta or {}).get("local_workspace_root") if isinstance(meta, dict) else None
        principal_id = str(ctx.get("principal_id") or "").strip()

        def _build_standing() -> str:
            return build_memory_injection_sections(
                agent_name=agent_name,
                local_workspace_root=lw,
                injection_profile=mem_profile,
                prompt_language=pl,
                query="",
                include_query_recall=False,
                principal_id=principal_id,
            )

        standing = get_frozen_standing_memory(tid, _build_standing)
        base = strip_memory_xml_blocks(str(getattr(sm, "content", "") or "")).rstrip()
        if standing:
            merged = f"{base}\n\n{standing}".strip() if base else standing
        else:
            merged = base

        if merged != str(getattr(sm, "content", "") or "").strip():
            request = request.override(system_message=sm.model_copy(update={"content": merged}))
            logger.debug(
                "MemoryLiveFooter: applied frozen standing memory agent=%s profile=%s chars=%d",
                agent_name,
                mem_profile,
                len(standing),
            )

        query = _latest_user_query(messages)
        preview = (standing or "").strip()
        if len(preview) > 400:
            preview = preview[:400] + "…"
        recall_on = _query_recall_enabled()
        recall = (
            build_memory_query_recall_sections(
                agent_name=agent_name,
                query=query,
                thread_id=tid,
                standing_preview=preview,
            )
            if recall_on and query
            else ""
        )
        if not recall_on:
            # Still strip any prior recall messages so a flip mid-session doesn't leave stale hints
            if len(messages) != len(_messages_from_request(request)):
                return request.override(messages=messages)
            return request
        if not query and tid and standing:
            # Still record standing-only snapshot so chip can show Core was injected
            try:
                from evoflow.memory.recall_snapshot import record_thread_recall

                record_thread_recall(
                    tid,
                    query="",
                    standing_preview=preview,
                    hits=[],
                    source="standing",
                )
            except Exception:
                pass
        if recall.strip() and messages:
            hint = HumanMessage(content=recall.strip(), name=_MEMORY_RECALL_MESSAGE_NAME)
            return request.override(messages=[*messages, hint])

        if len(messages) != len(_messages_from_request(request)):
            return request.override(messages=messages)
        return request

    @override
    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return handler(self._patch_request(request))

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return await handler(self._patch_request(request))
