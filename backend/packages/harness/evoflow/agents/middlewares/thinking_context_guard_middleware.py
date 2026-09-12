"""Disable thinking on very large contexts to avoid output-budget truncation with no visible reply."""

from __future__ import annotations

import contextvars
import logging
import os
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest
from langgraph.runtime import Runtime

from evoflow.agents.context_compaction_core import compaction_token_snapshot
from evoflow.agents.middlewares.context_compaction_middleware import _messages_from_request
from evoflow.utils.model_context_length import resolve_model_context_length

logger = logging.getLogger(__name__)

_DEFAULT_GATE_TOKENS = 100_000
_NOTIFIED_THIS_TURN: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "evf_thinking_guard_notified",
    default=False,
)


def thinking_disable_gate_tokens() -> int:
    raw = os.environ.get("EVOFLOW_THINKING_DISABLE_GATE_TOKENS", "").strip()
    if not raw:
        return _DEFAULT_GATE_TOKENS
    try:
        return max(1, int(raw))
    except ValueError:
        return _DEFAULT_GATE_TOKENS


def _thinking_guard_notice(gate_tokens: int) -> str:
    return (
        f"上下文约 {gate_tokens // 1000}K token，已自动关闭 Thinking，避免输出预算被思考链占满。"
        "如需深度推理，请缩短会话或开新 thread 后再开启 Thinking。"
    )


def _runtime_context(runtime: Runtime | None) -> dict[str, Any]:
    ctx = getattr(runtime, "context", None) if runtime is not None else None
    return dict(ctx) if isinstance(ctx, dict) else {}


def _thinking_requested(runtime: Runtime | None) -> bool:
    ctx = _runtime_context(runtime)
    if str(ctx.get("session_mode") or "").strip().lower() == "flash":
        return False
    thinking_type = str(ctx.get("thinking_type") or "").strip().lower()
    if thinking_type in ("auto", "disabled"):
        # Auto = omit vendor params; not an explicit thinking request.
        return False
    te = ctx.get("thinking_enabled")
    if te is False:
        return False
    if te is True:
        return True
    return False


def _resolve_model_name(runtime: Runtime | None) -> str | None:
    ctx = _runtime_context(runtime)
    name = str(ctx.get("model_name") or ctx.get("model") or "").strip()
    return name or None


def _emit_thinking_guard_notice(text: str, runtime: Runtime | None) -> None:
    try:
        from langgraph.config import get_stream_writer

        writer = get_stream_writer()
        if writer:
            writer({"type": "thinking_context_guard", "text": text})
    except Exception:
        logger.debug("thinking guard stream emit failed", exc_info=True)
    tid = str(_runtime_context(runtime).get("thread_id") or "").strip() or None
    logger.warning("Thinking disabled for large context thread=%s notice=%s", tid, text[:200])


def _disable_thinking_on_model(model: Any) -> Any:
    try:
        return model.bind(
            extra_body={"thinking": {"type": "disabled"}},
            reasoning_effort="minimal",
        )
    except Exception:
        logger.debug("thinking guard model.bind failed", exc_info=True)
        return model


def _maybe_guard_request(request: ModelRequest) -> ModelRequest:
    if not _thinking_requested(request.runtime):
        return request
    messages = _messages_from_request(request)
    if not messages:
        return request
    model_name = _resolve_model_name(request.runtime)
    ctx_len = resolve_model_context_length(model_name)
    snap = compaction_token_snapshot(messages, context_length=ctx_len)
    gate = int(snap.get("gate_tokens") or 0)
    threshold = thinking_disable_gate_tokens()
    if gate < threshold:
        return request
    notice = _thinking_guard_notice(gate)
    if not _NOTIFIED_THIS_TURN.get():
        _NOTIFIED_THIS_TURN.set(True)
        _emit_thinking_guard_notice(notice, request.runtime)
    bound = _disable_thinking_on_model(request.model)
    if bound is request.model:
        return request
    return request.override(model=bound)


class ThinkingContextGuardMiddleware(AgentMiddleware[AgentState]):
    """Turn off thinking when the model-bound context exceeds a token gate."""

    @override
    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        req = _maybe_guard_request(request)
        return handler(req)

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        req = _maybe_guard_request(request)
        return await handler(req)
