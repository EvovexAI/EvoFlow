"""Inject rolling user-intent summary as ephemeral HumanMessage turn-tail (not system)."""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage

from evoflow.agents.automation_runtime import is_unattended_automation
from evoflow.agents.message_analysis_utils import is_real_user_message
from evoflow.config.session_intent_config import get_session_intent_config

logger = logging.getLogger(__name__)

_SESSION_INTENT_MESSAGE_NAME = "session_intent"


def _human_texts(messages: list, *, max_turns: int) -> list[str]:
    texts: list[str] = []
    for msg in reversed(messages):
        if not isinstance(msg, HumanMessage):
            continue
        if getattr(msg, "name", None) == _SESSION_INTENT_MESSAGE_NAME:
            continue
        if not is_real_user_message(msg):
            continue
        content = getattr(msg, "content", "") or ""
        if isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(str(block.get("text") or ""))
                elif isinstance(block, str):
                    parts.append(block)
            content = "\n".join(parts)
        text = str(content).strip()
        if text:
            texts.append(text[:500])
        if len(texts) >= max_turns:
            break
    return list(reversed(texts))


def _model_name_from_runtime(runtime: object | None) -> str | None:
    if runtime is None:
        return None
    ctx = getattr(runtime, "context", None)
    if ctx is not None:
        try:
            name = ctx.get("model_name") if hasattr(ctx, "get") else None
            if name:
                return str(name).strip() or None
        except Exception:
            pass
    try:
        from langgraph.config import get_config

        name = get_config().get("configurable", {}).get("model_name")
        if name:
            return str(name).strip() or None
    except Exception:
        pass
    try:
        _tid = ctx.get("thread_id") if ctx is not None and hasattr(ctx, "get") else None
        if not _tid:
            _tid = get_config().get("configurable", {}).get("thread_id")
        if _tid:
            from evoflow.persistence.session_repositories import get_model_name_for_thread

            _name = get_model_name_for_thread(str(_tid).strip())
            if _name:
                return str(_name).strip() or None
    except Exception:
        pass
    return None


def _prepare_rollup(
    prior: list[str], *, model_name: str | None = None
) -> tuple[object, str] | None:
    cfg = get_session_intent_config()
    if not cfg.llm_rollup_enabled:
        return None
    combined = "\n---\n".join(prior)
    if len(combined) < cfg.llm_rollup_min_chars:
        return None
    cap = min(len(combined), cfg.llm_rollup_max_input_chars)
    snippet = combined[:cap]
    try:
        from evoflow.models import create_chat_model

        resolved = cfg.llm_rollup_model_name or model_name
        model = create_chat_model(resolved, thinking_enabled=False)
    except Exception as e:
        logger.debug("session intent LLM rollup model init failed: %s", e)
        return None
    prompt = (
        "Cluster the user's prior messages into a concise intent summary for the assistant.\n"
        "- Merge duplicate or overlapping goals into themes.\n"
        "- 2-4 short sentences total; focus on outcomes, not tool/file names.\n"
        "- Plain text only, no bullets.\n\n"
        f"{snippet}"
    )
    return model, prompt


def _rollup_response_to_text(resp: object) -> str | None:
    text = str(getattr(resp, "content", "") or resp).strip()
    return text[:1200] if text else None


def _llm_rollup(prior: list[str], *, model_name: str | None = None) -> str | None:
    prepared = _prepare_rollup(prior, model_name=model_name)
    if prepared is None:
        return None
    model, prompt = prepared
    try:
        resp = model.invoke(prompt)
        return _rollup_response_to_text(resp)
    except Exception as e:
        logger.debug("session intent LLM rollup failed: %s", e)
        return None


async def _llm_rollup_async(
    prior: list[str], *, model_name: str | None = None
) -> str | None:
    prepared = _prepare_rollup(prior, model_name=model_name)
    if prepared is None:
        return None
    model, prompt = prepared
    try:
        resp = await asyncio.to_thread(model.invoke, prompt)
        return _rollup_response_to_text(resp)
    except Exception as e:
        logger.debug("session intent LLM rollup failed: %s", e)
        return None


def _mission_primary_objective(thread_id: str) -> str:
    tid = str(thread_id or "").strip()
    if not tid:
        return ""
    try:
        from evoflow.agents.mission_state.config import MISSION_STATE_ENABLED
        from evoflow.agents.mission_state.storage import load_mission_state

        if not MISSION_STATE_ENABLED:
            return ""
        ms = load_mission_state(tid)
        if ms is None:
            return ""
        return str(ms.primary_objective or "").strip()
    except Exception:
        return ""


def _build_intent_block(messages: list, *, thread_id: str = "", model_name: str | None = None) -> str:
    cfg = get_session_intent_config()
    if not cfg.enabled:
        return ""
    if _mission_primary_objective(thread_id):
        return ""
    texts = _human_texts(messages, max_turns=cfg.max_turns + 1)
    if len(texts) <= 1:
        return ""
    prior = texts[:-1]
    if not prior:
        return ""
    prior = prior[-cfg.max_turns :]
    rollup = _llm_rollup(prior, model_name=model_name)
    lines = ["<session_intent>"]
    if rollup:
        lines.extend(["Rolling summary of user goals:", "", rollup])
    else:
        lines.extend(["Recent user goals in this thread (newest last):", ""])
        for i, t in enumerate(prior, 1):
            lines.append(f"{i}. {t}")
    lines.append("</session_intent>")
    return "\n".join(lines)


async def _build_intent_block_async(
    messages: list, *, thread_id: str = "", model_name: str | None = None
) -> str:
    cfg = get_session_intent_config()
    if not cfg.enabled:
        return ""
    if _mission_primary_objective(thread_id):
        return ""
    texts = _human_texts(messages, max_turns=cfg.max_turns + 1)
    if len(texts) <= 1:
        return ""
    prior = texts[:-1]
    if not prior:
        return ""
    prior = prior[-cfg.max_turns :]
    rollup = await _llm_rollup_async(prior, model_name=model_name)
    lines = ["<session_intent>"]
    if rollup:
        lines.extend(["Rolling summary of user goals:", "", rollup])
    else:
        lines.extend(["Recent user goals in this thread (newest last):", ""])
        for i, t in enumerate(prior, 1):
            lines.append(f"{i}. {t}")
    lines.append("</session_intent>")
    return "\n".join(lines)


def strip_session_intent_from_system_prompt(text: str) -> str:
    out = re.sub(r"<session_intent>[\s\S]*?</session_intent>\s*", "\n", str(text or ""), flags=re.IGNORECASE)
    return re.sub(r"\n{3,}", "\n\n", out).rstrip()


def _is_session_intent_message(msg: Any) -> bool:
    return isinstance(msg, (SystemMessage, HumanMessage, ToolMessage)) and getattr(
        msg, "name", None
    ) == _SESSION_INTENT_MESSAGE_NAME


def _strip_session_intent_messages(messages: list[Any]) -> list[Any]:
    return [m for m in messages if not _is_session_intent_message(m)]


def _messages_from_request(request: ModelRequest) -> list[BaseMessage]:
    state_msgs: list[Any] = (
        list((request.state or {}).get("messages") or []) if isinstance(request.state, dict) else []
    )
    req_msgs: list[Any] = list(request.messages or []) if getattr(request, "messages", None) else []
    raw = state_msgs if len(state_msgs) >= len(req_msgs) else req_msgs
    return [m for m in raw if isinstance(m, BaseMessage)]


class SessionIntentMiddleware(AgentMiddleware[AgentState]):
    """Append intent summary as named HumanMessage; strip legacy system blocks."""

    def _thread_id(self, request: ModelRequest) -> str:
        ctx = getattr(request.runtime, "context", None) or {}
        tid = str(ctx.get("thread_id") or "").strip()
        if tid:
            return tid
        try:
            from langgraph.config import get_config

            return str(get_config().get("configurable", {}).get("thread_id") or "").strip()
        except Exception:
            return ""

    def _model_name(self, request: ModelRequest) -> str | None:
        return _model_name_from_runtime(getattr(request, "runtime", None))

    def _apply_block(self, request: ModelRequest, block: str) -> ModelRequest:
        sm = request.system_message
        if sm is not None:
            raw = sm.content if isinstance(sm.content, str) else str(sm.content or "")
            base = strip_session_intent_from_system_prompt(raw)
            if base != raw.rstrip():
                request = request.override(system_message=SystemMessage(content=base))

        messages = _strip_session_intent_messages(_messages_from_request(request))
        if not block or not messages:
            if len(messages) != len(_messages_from_request(request)):
                return request.override(messages=messages)
            return request

        hint = HumanMessage(content=block.strip(), name=_SESSION_INTENT_MESSAGE_NAME)
        return request.override(messages=[*messages, hint])

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelCallResult],
    ) -> ModelCallResult:
        if is_unattended_automation(getattr(request, "runtime", None)):
            return handler(request)
        block = _build_intent_block(
            list((request.state or {}).get("messages") or []),
            thread_id=self._thread_id(request),
            model_name=self._model_name(request),
        )
        return handler(self._apply_block(request, block))

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelCallResult]],
    ) -> ModelCallResult:
        if is_unattended_automation(getattr(request, "runtime", None)):
            return await handler(request)
        block = await _build_intent_block_async(
            list((request.state or {}).get("messages") or []),
            thread_id=self._thread_id(request),
            model_name=self._model_name(request),
        )
        return await handler(self._apply_block(request, block))
