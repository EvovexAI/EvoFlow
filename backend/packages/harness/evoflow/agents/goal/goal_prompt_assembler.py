"""Prompt Assembler: map ``pending_continuation`` to ephemeral synthetic user at model invoke time."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any, override

from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest, ModelResponse
from langchain_core.messages import HumanMessage
from langgraph.config import get_config

from evoflow.agents.goal.goal_runtime import (
    build_goal_mode_preamble,
    goal_mode_from_runtime,
    load_goal_row,
    pop_pending_goal_nudge,
    resolve_session_key,
)
from evoflow.agents.goal.goal_state import GOAL_CONTROLLER_SOURCE, GOAL_SYNTHETIC_USER_NAME

logger = logging.getLogger(__name__)


def _pending_continuation_from_runtime(runtime: Any) -> str:
    ctx = getattr(runtime, "context", None) if runtime is not None else None
    if isinstance(ctx, dict):
        text = str(ctx.get("pending_continuation") or "").strip()
        if text:
            return text
    try:
        cfg = get_config()
        conf = cfg.get("configurable") if isinstance(cfg, dict) else {}
        if isinstance(conf, dict):
            return str(conf.get("pending_continuation") or "").strip()
    except Exception:
        pass
    return ""


def _append_synthetic_goal_user(messages: list[Any], continuation: str) -> list[Any]:
    if not continuation:
        return list(messages or [])
    out = list(messages or [])
    out.append(
        HumanMessage(
            content=continuation,
            name=GOAL_SYNTHETIC_USER_NAME,
            additional_kwargs={
                "internal": True,
                "source": GOAL_CONTROLLER_SOURCE,
                "synthetic": True,
                "visibility": "internal",
            },
        )
    )
    return out


class GoalContinuationAssemblerMiddleware(AgentMiddleware):
    """Inject goal continuation (or first-turn preamble) as synthetic user for this model call only."""

    def _resolve_continuation(self, request: ModelRequest) -> str:
        """Return continuation text, or first-turn preamble if goal mode + no prior synthetic."""
        sk = resolve_session_key(getattr(request, "runtime", None))
        if sk:
            nudge = pop_pending_goal_nudge(sk)
            if nudge:
                return nudge
        continuation = _pending_continuation_from_runtime(None)
        if continuation:
            return continuation
        # First turn in goal mode: no continuation yet, inject preamble so the model
        # knows it's in goal mode from the very first reply.
        if not goal_mode_from_runtime(getattr(request, "runtime", None)):
            return ""
        messages = list((request.state or {}).get("messages") or []) if isinstance(request.state, dict) else []
        has_synth = any(
            isinstance(m, HumanMessage)
            and str(getattr(m, "name", "") or "").strip() == GOAL_SYNTHETIC_USER_NAME
            for m in messages
        )
        if has_synth:
            return ""
        if not sk:
            return ""
        row = load_goal_row(sk)
        if not row:
            return ""
        return build_goal_mode_preamble(
            goal_text=str(row.get("prompt") or "").strip(),
            max_steps=int(row.get("max_steps") or 50),
        )

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelCallResult:
        continuation = self._resolve_continuation(request)
        if continuation:
            patched = _append_synthetic_goal_user(request.messages, continuation)
            request = request.override(messages=patched)
        return handler(request)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelCallResult:
        continuation = self._resolve_continuation(request)
        if continuation:
            patched = _append_synthetic_goal_user(request.messages, continuation)
            request = request.override(messages=patched)
            logger.debug(
                "goal_prompt_assembler: injected synthetic user len=%s source=%s",
                len(continuation),
                GOAL_CONTROLLER_SOURCE,
            )
        return await handler(request)
