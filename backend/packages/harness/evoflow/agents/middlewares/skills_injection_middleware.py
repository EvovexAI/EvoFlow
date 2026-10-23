"""Inject selected skill / plugin context after the triggering user message.

Placement (important)::

    [history…, user, <skill_injection>?, <plugin_injection>?, AI, tool, …]

Composer-selected skills and plugins are inserted **immediately after the
triggering user HumanMessage**, not appended to the end of the list. Within a
tool loop the injection is ephemeral (``request.override``) so each model call
re-places it after that same user row; tool results stay newer than the
injection (chronological end = latest attention).

This matches ``KbInjectionMiddleware`` (which runs after this middleware and
inserts KB between the user and these rows).
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
from langchain_core.messages import BaseMessage, HumanMessage

from evoflow.agents.lead_agent.runtime_context import (
    merge_model_request_runtime_context,
    resolve_preferred_plugins_for_turn,
    resolve_preferred_skills_for_turn,
)
from evoflow.skills.active import reset_active_skills, set_active_skills
from evoflow.skills.injection import build_skill_injection_message
from evoflow.skills.selection import select_skills_for_turn
from evoflow.agents.middlewares.dynamic_system_prompt_middleware import (
    get_injected_sections,
    reset_injected_sections,
    set_injected_sections,
)

logger = logging.getLogger(__name__)

_SKILL_INJECTION_MESSAGE_NAME = "evf_skill_injection"
_PLUGIN_INJECTION_MESSAGE_NAME = "evf_plugin_injection"

_INJECTION_MESSAGE_NAMES = {_SKILL_INJECTION_MESSAGE_NAME, _PLUGIN_INJECTION_MESSAGE_NAME}

# Other ephemeral HumanMessage.name values that must not be treated as the user query.
_NON_USER_HUMAN_NAMES = frozenset(
    {
        _SKILL_INJECTION_MESSAGE_NAME,
        _PLUGIN_INJECTION_MESSAGE_NAME,
        "evf_kb_injection",
        "external_memory_prefetch",
        "todo_reminder",
    }
)


def _is_injection_message(msg: Any) -> bool:
    return isinstance(msg, HumanMessage) and getattr(msg, "name", None) in _INJECTION_MESSAGE_NAMES


def _strip_injection_messages(messages: list[Any]) -> list[Any]:
    return [m for m in messages if not _is_injection_message(m)]


def _messages_from_request(request: ModelRequest) -> list[BaseMessage]:
    from evoflow.agents.middlewares.model_request_messages import messages_from_model_request

    return messages_from_model_request(request)


def _is_real_user_human(msg: Any) -> bool:
    """True for a user turn HumanMessage (not middleware injection rows)."""
    t = str(getattr(msg, "type", None) or "").strip().lower()
    if t not in {"human", "user"} and not isinstance(msg, HumanMessage):
        return False
    if t not in {"human", "user"} and isinstance(msg, HumanMessage):
        t = "human"
    if t not in {"human", "user"}:
        return False
    name = str(getattr(msg, "name", None) or "").strip()
    if name in _NON_USER_HUMAN_NAMES:
        return False
    return True


def _latest_real_human_index(messages: list[Any]) -> int:
    for i in range(len(messages or []) - 1, -1, -1):
        if _is_real_user_human(messages[i]):
            return i
    return -1


def _human_content_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(parts).strip()
    return ""


def _latest_human_preview(messages: list[Any]) -> str:
    idx = _latest_real_human_index(messages or [])
    if idx < 0:
        return ""
    return _human_content_text(getattr(messages[idx], "content", ""))


def place_injections_after_latest_user(
    messages: list[Any],
    injections: list[HumanMessage],
) -> list[Any]:
    """Strip prior skill/plugin rows and insert ``injections`` right after the latest real user.

    Tool / AI / KB messages that follow the user stay after the injection block so
    the chronological end of the list remains the newest tool evidence.
    """
    cleaned = _strip_injection_messages(list(messages or []))
    if not injections:
        return cleaned
    idx = _latest_real_human_index(cleaned)
    if idx < 0:
        return [*cleaned, *injections]
    return [*cleaned[: idx + 1], *injections, *cleaned[idx + 1 :]]


def _resolve_turn_skills(request: ModelRequest) -> tuple[list, list[str], str, dict[str, Any]]:
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

    plugin_block = ""
    try:
        plugin_refs = resolve_preferred_plugins_for_turn(ctx)
        if plugin_refs:
            from evoflow.plugins.runtime import build_plugin_injection_block

            plugin_block = build_plugin_injection_block(plugin_refs, user_message=user_message)
    except Exception:
        logger.warning("Plugin injection block failed", exc_info=True)
        plugin_block = ""
    return selected, names, plugin_block, ctx


class SkillsInjectionMiddleware(AgentMiddleware[AgentState]):
    """Load SKILL.md / plugin metadata for composer-selected turn context."""

    state_schema = AgentState

    def _patch_request(
        self,
        request: ModelRequest,
        selected: list,
        names: list[str],
        plugin_block: str,
        ctx: dict[str, Any],
    ) -> ModelRequest:
        raw_messages = _messages_from_request(request)
        messages = _strip_injection_messages(raw_messages)

        if hasattr(request.runtime, "context"):
            rt_ctx = request.runtime.context
            if isinstance(rt_ctx, dict):
                rt_ctx["evf_active_skills"] = names
            elif hasattr(rt_ctx, "__setitem__"):
                rt_ctx["evf_active_skills"] = names

        if not selected and not plugin_block.strip():
            if len(messages) != len(raw_messages):
                return request.override(messages=messages)
            return request

        extra_messages: list[HumanMessage] = []
        if selected:
            body = build_skill_injection_message(
                selected,
                prompt_language=str(ctx.get("prompt_language") or "").strip() or None,
            )
            if body.strip():
                extra_messages.append(HumanMessage(content=body.strip(), name=_SKILL_INJECTION_MESSAGE_NAME))
        if plugin_block.strip():
            extra_messages.append(
                HumanMessage(content=plugin_block.strip(), name=_PLUGIN_INJECTION_MESSAGE_NAME)
            )
        if not extra_messages:
            return request.override(messages=messages) if len(messages) != len(raw_messages) else request

        logger.info(
            "SkillsInjection: injecting %d skill(s): %s; plugin block: %s",
            len(selected),
            names,
            bool(plugin_block.strip()),
        )
        return request.override(messages=place_injections_after_latest_user(raw_messages, extra_messages))

    @override
    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        selected, names, plugin_block, ctx = _resolve_turn_skills(request)
        token_skills = set_active_skills(names)
        try:
            result = handler(self._patch_request(request, selected, names, plugin_block, ctx))
            # Also update the injected-sections ContextVar so the detail modal sees the content.
            merged = dict(get_injected_sections() or {})
            if selected:
                body = build_skill_injection_message(
                    selected,
                    prompt_language=str(ctx.get("prompt_language") or "").strip() or None,
                )
                if body.strip():
                    merged["skill_injection"] = body.strip()
            if plugin_block.strip():
                merged["plugin_injection"] = plugin_block.strip()
            if len(merged) > len(get_injected_sections() or {}):
                tok = set_injected_sections(merged)
                try:
                    _ = result
                finally:
                    reset_injected_sections(tok)
            return result
        finally:
            reset_active_skills(token_skills)

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        selected, names, plugin_block, ctx = _resolve_turn_skills(request)
        token_skills = set_active_skills(names)
        try:
            result = await handler(self._patch_request(request, selected, names, plugin_block, ctx))
            merged = dict(get_injected_sections() or {})
            if selected:
                body = build_skill_injection_message(
                    selected,
                    prompt_language=str(ctx.get("prompt_language") or "").strip() or None,
                )
                if body.strip():
                    merged["skill_injection"] = body.strip()
            if plugin_block.strip():
                merged["plugin_injection"] = plugin_block.strip()
            if len(merged) > len(get_injected_sections() or {}):
                tok = set_injected_sections(merged)
                try:
                    _ = result
                finally:
                    reset_injected_sections(tok)
            return result
        finally:
            reset_active_skills(token_skills)
