"""Append fresh collaboration / task snapshot to the **end of the message list** every model call.

Mirrors ``ExplorationGraphLiveFooterMiddleware`` (mind map): ephemeral ``HumanMessage`` tail
injection, not checkpointed — stripped and re-built each ``wrap_model_call``.

Legacy blocks appended to compile-time system text (``<evoflow_live_collab_meta>``) are stripped
from ``system_message`` so summarization / fingerprint skips cannot duplicate them.

Opt out entirely: ``EVOFLOW_COLLAB_LIVE_CONTEXT_FOOTER=0`` (default **on**).
"""

from __future__ import annotations

import os
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

import logging

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage

logger = logging.getLogger(__name__)

_COLLAB_LIVE_MESSAGE_NAME = "session_collab_live"


def _env_bool(name: str, default: bool) -> bool:
    raw = (os.getenv(name) or "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _should_append_live_collab_footer(runtime: Any, state: dict | None) -> bool:
    """True when orchestration/plan-style scenarios are active (see ``effective_activated_scenario_keys``).

    Pure chat (no activated ``plan``/``workspace``/… keys) skips the footer: ``build_task_progress_snapshot``
    still returns a dict for idle threads, which would otherwise always emit live collab meta.
    """
    try:
        from evoflow.agents.middlewares.plan_guard_middleware import effective_activated_scenario_keys

        msgs = list((state or {}).get("messages") or []) if isinstance(state, dict) else []
        keys = effective_activated_scenario_keys(runtime, msgs)
        return bool(keys)
    except Exception:
        return True


def _is_collab_live_message(msg: Any) -> bool:
    return isinstance(msg, (HumanMessage, SystemMessage, ToolMessage)) and getattr(msg, "name", None) == _COLLAB_LIVE_MESSAGE_NAME


def _strip_collab_live_messages(messages: list[Any]) -> list[Any]:
    return [m for m in messages if not _is_collab_live_message(m)]


def _messages_from_request(request: ModelRequest) -> list[BaseMessage]:
    from evoflow.agents.middlewares.model_request_messages import messages_from_model_request

    return messages_from_model_request(request)


def _strip_stale_system_live_blocks(request: ModelRequest) -> ModelRequest:
    try:
        from evoflow.agents.lead_agent.prompt import strip_thread_live_context_from_system_prompt
    except Exception:
        return request
    sm = request.system_message
    if sm is None:
        return request
    raw = str(getattr(sm, "content", "") or "")
    base = strip_thread_live_context_from_system_prompt(raw)
    if base == raw.rstrip():
        return request
    if not base.strip():
        return request.override(system_message=SystemMessage(content=""))
    return request.override(system_message=sm.model_copy(update={"content": base.strip()}))


class CollabThreadLiveContextFooterMiddleware(AgentMiddleware[AgentState]):
    """Runs after ``ScenarioRuntimeHintMiddleware``; injects live plan/task state at message tail."""

    state_schema = AgentState

    def _patch_request(self, request: ModelRequest) -> ModelRequest:
        if not _env_bool("EVOFLOW_COLLAB_LIVE_CONTEXT_FOOTER", True):
            return request
        request = _strip_stale_system_live_blocks(request)
        ctx = request.runtime.context if isinstance(request.runtime.context, dict) else {}
        tid = str(ctx.get("thread_id") or "").strip()
        state = request.state if isinstance(request.state, dict) else {}
        messages = _strip_collab_live_messages(_messages_from_request(request))

        if not tid:
            if len(messages) != len(_messages_from_request(request)):
                return request.override(messages=messages)
            return request

        meta = ctx.get("evf_dynamic_prompt_meta")
        pl = meta.get("prompt_language") if isinstance(meta, dict) else None
        if not pl:
            pl = ctx.get("prompt_language")

        appendix = ""
        if _should_append_live_collab_footer(request.runtime, state):
            try:
                from evoflow.agents.lead_agent.prompt import build_thread_live_context_appendix

                appendix = build_thread_live_context_appendix(tid, prompt_language=pl)
            except Exception:
                appendix = ""

        stage_appendix = ""
        try:
            from evoflow.stage.stage_context import build_stage_context_appendix

            stage_appendix = build_stage_context_appendix(tid)
        except Exception:
            stage_appendix = ""

        combined = "\n\n".join(
            part.strip() for part in (appendix, stage_appendix) if part and part.strip()
        )
        if not combined.strip():
            if len(messages) != len(_messages_from_request(request)):
                return request.override(messages=messages)
            return request

        try:
            logger.info(
                "CollabThreadLiveContextFooter: injecting live collab HumanMessage thread=%s chars=%d",
                tid,
                len(combined),
            )
            hint = HumanMessage(content=combined.strip(), name=_COLLAB_LIVE_MESSAGE_NAME)
            return request.override(messages=[*messages, hint])
        except Exception:
            logger.debug("CollabThreadLiveContextFooter: patch failed", exc_info=True)
            if len(messages) != len(_messages_from_request(request)):
                return request.override(messages=messages)
            return request

    @override
    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return handler(self._patch_request(request))

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return await handler(self._patch_request(request))

    @override
    def before_model(self, state: AgentState, runtime: Any) -> dict[str, Any] | None:  # noqa: ARG002
        return None

    @override
    async def abefore_model(self, state: AgentState, runtime: Any) -> dict[str, Any] | None:
        return None
