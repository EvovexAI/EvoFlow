"""Inject 小V page snapshot as an ephemeral named HumanMessage (never system).

Putting live UI into the system prompt busts prefix cache on every navigation.
Mirror mission/collab live footers: append ``name=xiaomi_ui_context`` before each
model call when ``runtime.context.xiaomi_page_context`` is present. The panel only
puts that field on the run when the page fingerprint changed since last send.

Also strip legacy copies that may have been checkpointed without ``name``, or
stale ``<xiaomi_ui_context>`` blocks left on ``system_message``.
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
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage

from evoflow.agents.middlewares.model_request_messages import (
    messages_from_model_request,
    strip_blank_unnamed_human_messages,
)

logger = logging.getLogger(__name__)

XIAOMI_UI_CONTEXT_MESSAGE_NAME = "xiaomi_ui_context"
_XIAOMI_UI_CONTEXT_TAG = "<xiaomi_ui_context>"


def _message_plain_text(msg: Any) -> str:
    content = getattr(msg, "content", None)
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                t = block.get("text")
                if isinstance(t, str):
                    parts.append(t)
        return "\n".join(parts)
    return str(content)


def _is_xiaomi_ui_context_message(msg: Any) -> bool:
    if not isinstance(msg, (HumanMessage, SystemMessage, ToolMessage)):
        return False
    if getattr(msg, "name", None) == XIAOMI_UI_CONTEXT_MESSAGE_NAME:
        return True
    text = _message_plain_text(msg).lstrip()
    return text.startswith(_XIAOMI_UI_CONTEXT_TAG)


def _strip_xiaomi_ui_context_messages(messages: list[Any]) -> list[Any]:
    return [m for m in messages if not _is_xiaomi_ui_context_message(m)]


class XiaomiUiContextLiveFooterMiddleware(AgentMiddleware[AgentState]):
    """Append current-page snapshot as a hidden-from-UI HumanMessage when provided."""

    state_schema = AgentState

    def _strip_stale_system_ui_context(self, request: ModelRequest) -> ModelRequest:
        sm = request.system_message
        if sm is None:
            return request
        try:
            from evoflow.agents.xiaomi.prompt import strip_xiaomi_ui_context_from_system_prompt
        except Exception:
            return request
        plain = _message_plain_text(sm) if not isinstance(getattr(sm, "content", None), str) else str(
            sm.content or ""
        )
        base = strip_xiaomi_ui_context_from_system_prompt(plain)
        if base == plain.rstrip():
            return request
        return request.override(system_message=sm.model_copy(update={"content": base}))

    def _patch_request(self, request: ModelRequest) -> ModelRequest:
        request = self._strip_stale_system_ui_context(request)
        base_msgs = messages_from_model_request(request)
        messages = _strip_xiaomi_ui_context_messages(base_msgs)
        try:
            from evoflow.agents.middlewares.dynamic_system_prompt_middleware import (
                _merged_runtime_context,
            )
            from evoflow.agents.xiaomi.identity import is_xiaomi_agent
            from evoflow.agents.xiaomi.prompt import format_page_context_block
        except Exception:
            if len(messages) != len(base_msgs):
                return request.override(messages=messages)
            return request

        ctx = _merged_runtime_context(request)
        agent = str(ctx.get("agent_name") or ctx.get("agent_id") or "").strip()
        if not is_xiaomi_agent(agent):
            if len(messages) != len(base_msgs):
                return request.override(messages=messages)
            return request

        # Drop blank Human rows that accumulate as empty content parts in vendor payload.
        messages = strip_blank_unnamed_human_messages(messages)

        raw_pc = ctx.get("xiaomi_page_context")
        if not isinstance(raw_pc, dict) or not raw_pc:
            if len(messages) != len(base_msgs):
                return request.override(messages=messages)
            return request

        pl = None
        meta = ctx.get("evf_dynamic_prompt_meta")
        if isinstance(meta, dict):
            pl = meta.get("prompt_language")
        if not pl:
            pl = ctx.get("prompt_language")

        body = format_page_context_block(raw_pc, prompt_language=pl)
        if not str(body or "").strip():
            if len(messages) != len(base_msgs):
                return request.override(messages=messages)
            return request

        try:
            hint = HumanMessage(content=body.strip(), name=XIAOMI_UI_CONTEXT_MESSAGE_NAME)
            return request.override(messages=[*messages, hint])
        except Exception:
            logger.debug("XiaomiUiContextLiveFooter: patch failed", exc_info=True)
            if len(messages) != len(base_msgs):
                return request.override(messages=messages)
            return request

    @override
    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return handler(self._patch_request(request))

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return await handler(self._patch_request(request))
