"""Inject selected skill SKILL.md bodies at the message tail each model call."""

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
from langchain_core.messages import BaseMessage, HumanMessage

from evoflow.agents.lead_agent.runtime_context import (
    merge_model_request_runtime_context,
    resolve_preferred_skills_for_turn,
)
from evoflow.skills.active import reset_active_skills, set_active_skills
from evoflow.skills.injection import build_skill_injection_message
from evoflow.skills.selection import select_skills_for_turn

logger = logging.getLogger(__name__)

_SKILL_INJECTION_MESSAGE_NAME = "evf_skill_injection"


def _is_skill_injection_message(msg: Any) -> bool:
    return isinstance(msg, HumanMessage) and getattr(msg, "name", None) == _SKILL_INJECTION_MESSAGE_NAME


def _strip_skill_injection_messages(messages: list[Any]) -> list[Any]:
    return [m for m in messages if not _is_skill_injection_message(m)]


def _messages_from_request(request: ModelRequest) -> list[BaseMessage]:
    from evoflow.agents.middlewares.model_request_messages import messages_from_model_request

    return messages_from_model_request(request)


def _latest_human_preview(messages: list[Any]) -> str:
    for msg in reversed(messages or []):
        t = str(getattr(msg, "type", None) or "").strip().lower()
        if t not in {"human", "user"}:
            continue
        content = getattr(msg, "content", "")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(str(block.get("text") or ""))
            return "\n".join(parts).strip()
    return ""


def _resolve_turn_skills(request: ModelRequest) -> tuple[list, list[str], dict[str, Any]]:
    ctx = merge_model_request_runtime_context(request)
    messages = _messages_from_request(request)

    preferred = resolve_preferred_skills_for_turn(ctx)
    user_message = str(ctx.get("evf_user_question") or "").strip() or _latest_human_preview(messages)
    workspace = str(ctx.get("local_workspace_root") or "").strip() or None

    selected = select_skills_for_turn(
        preferred_skills=preferred,
        user_message=user_message,
        enabled_only=True,
        workspace_root=workspace,
    )
    names = [s.name for s in selected]
    return selected, names, ctx


class SkillsInjectionMiddleware(AgentMiddleware[AgentState]):
    """Load SKILL.md for composer-selected / ``$mentioned`` skills (native-style turn injection)."""

    state_schema = AgentState

    def _patch_request(
        self,
        request: ModelRequest,
        selected: list,
        names: list[str],
        ctx: dict[str, Any],
    ) -> ModelRequest:
        messages = _strip_skill_injection_messages(_messages_from_request(request))

        if hasattr(request.runtime, "context"):
            rt_ctx = request.runtime.context
            if isinstance(rt_ctx, dict):
                rt_ctx["evf_active_skills"] = names
            elif hasattr(rt_ctx, "__setitem__"):
                rt_ctx["evf_active_skills"] = names

        if not selected:
            if len(messages) != len(_messages_from_request(request)):
                return request.override(messages=messages)
            return request

        body = build_skill_injection_message(
            selected,
            prompt_language=str(ctx.get("prompt_language") or "").strip() or None,
        )
        if not body.strip():
            return request

        logger.info("SkillsInjection: injecting %d skill(s): %s", len(selected), names)
        hint = HumanMessage(content=body.strip(), name=_SKILL_INJECTION_MESSAGE_NAME)
        return request.override(messages=[*messages, hint])

    @override
    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        selected, names, ctx = _resolve_turn_skills(request)
        token = set_active_skills(names)
        try:
            return handler(self._patch_request(request, selected, names, ctx))
        finally:
            reset_active_skills(token)

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        selected, names, ctx = _resolve_turn_skills(request)
        token = set_active_skills(names)
        try:
            return await handler(self._patch_request(request, selected, names, ctx))
        finally:
            reset_active_skills(token)
