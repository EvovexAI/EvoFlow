"""Unified context compaction: fold at model-call time; summaries persist in evoflow_chat_messages."""

from __future__ import annotations

import asyncio
import contextvars
import logging
import os
from collections.abc import Awaitable
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as _FutureTimeoutError
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest
from langchain_core.messages import AIMessage, BaseMessage
from langgraph.runtime import Runtime

from evoflow.agents.context_compaction_core import (
    compaction_token_snapshot,
    dedupe_compaction_artifacts,
    get_context_compaction_engine,
    log_compaction_gate,
    log_compaction_model_payload,
    log_compaction_pass_result,
    log_compaction_skipped,
    partition_compaction_artifacts,
    reset_gate_overhead_tokens,
    set_gate_overhead_tokens,
    should_passthrough_db_hydrated_transcript,
    strip_image_base64_from_messages,
    transcript_has_conversation_summary,
)
from evoflow.agents.compaction_trigger import get_compaction_trigger_cache
from evoflow.agents.context_compaction_events import (
    emit_compaction_end,
    emit_compaction_start,
    emit_context_usage,
)
from evoflow.agents.middlewares.message_usage_helpers import infer_usage_metadata_for_ai_message
from evoflow.agents.middlewares.tool_history_ager_middleware import apply_tool_history_fast
from evoflow.config.summarization_config import get_compaction_settings, get_summarization_config
from evoflow.context.compaction_token_utils import token_model_scope
from evoflow.context.context_compaction_queue import get_context_compaction_queue
from evoflow.context.model_request_token_estimate import (
    estimate_model_call_overhead,
    reset_gate_overhead_meta,
    set_gate_overhead_meta,
)
from evoflow.context.tool_history_ager_queue import get_tool_history_summary_queue
from evoflow.observability.compaction_run_context import (
    clear_compaction_snapshot,
    set_compaction_snapshot_for_main_call,
    set_compress_pass_label,
)
from evoflow.utils.model_context_length import compression_threshold_tokens, resolve_model_context_length

logger = logging.getLogger(__name__)

_COMPACTION_FOLDED_THIS_CALL: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "evoflow_compaction_folded_this_call",
    default=False,
)
_COMPACTION_FOLD_MSG_COUNTS: contextvars.ContextVar[tuple[int, int] | None] = contextvars.ContextVar(
    "evoflow_compaction_fold_msg_counts",
    default=None,
)
_BOUND_MODEL_MESSAGES: contextvars.ContextVar[list[BaseMessage] | None] = contextvars.ContextVar(
    "evoflow_bound_model_messages",
    default=None,
)
_SKIP_COMPACTION_ONCE: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "evoflow_skip_compaction_once",
    default=False,
)
_CONTEXT_USAGE_EMITTED_THIS_CALL: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "evoflow_context_usage_emitted_this_call",
    default=False,
)


def compaction_folded_this_call() -> bool:
    return bool(_COMPACTION_FOLDED_THIS_CALL.get())


def compaction_fold_msg_counts() -> tuple[int, int] | None:
    return _COMPACTION_FOLD_MSG_COUNTS.get()


def last_bound_model_messages() -> list[BaseMessage] | None:
    """Messages last bound for the model (post-fold), for empty-response retries."""
    bound = _BOUND_MODEL_MESSAGES.get()
    return list(bound) if bound else None


def mark_skip_compaction_once() -> None:
    """Next ephemeral fold in this task should be skipped (empty-response retry)."""
    _SKIP_COMPACTION_ONCE.set(True)


def consume_skip_compaction_once() -> bool:
    if _SKIP_COMPACTION_ONCE.get():
        _SKIP_COMPACTION_ONCE.set(False)
        return True
    return False


def _reset_compaction_call_markers() -> None:
    _COMPACTION_FOLDED_THIS_CALL.set(False)
    _COMPACTION_FOLD_MSG_COUNTS.set(None)
    _CONTEXT_USAGE_EMITTED_THIS_CALL.set(False)


def _mark_compaction_folded(*, before: int, after: int) -> None:
    _COMPACTION_FOLDED_THIS_CALL.set(True)
    _COMPACTION_FOLD_MSG_COUNTS.set((max(0, int(before)), max(0, int(after))))


_engine = get_context_compaction_engine()
_COMPRESS_POOL = ThreadPoolExecutor(max_workers=3, thread_name_prefix="evoflow-compact-sync")

# Hard ceiling for the sync compaction path. ``wrap_model_call`` (sync) blocks
# the agent loop while compression runs; a stuck LLM previously froze the main
# turn for up to 10 minutes (legacy ``timeout=600``). Cap at 120s and fall back
# to "no fold" instead of raising — the model call must always get a chance to
# proceed with the un-compacted history rather than time out the whole turn.
_SYNC_COMPACTION_TIMEOUT_S = float(os.getenv("EVOFLOW_SYNC_COMPACTION_TIMEOUT_S", "120") or 120)


def _thread_id_from_runtime(runtime: Runtime | None) -> str:
    if runtime is None:
        return "default"
    ctx = getattr(runtime, "context", None) or {}
    if isinstance(ctx, dict):
        for key in ("thread_id", "session_key"):
            val = ctx.get(key)
            if val:
                return str(val).strip()
    try:
        from langgraph.config import get_config

        tid = str(get_config().get("configurable", {}).get("thread_id") or "").strip()
        if tid:
            return tid
    except Exception:
        pass
    return "default"


def _session_key_from_runtime(runtime: Runtime | None) -> str:
    if runtime is None:
        return ""
    ctx = getattr(runtime, "context", None) or {}
    if isinstance(ctx, dict):
        sk = ctx.get("session_key")
        if sk:
            return str(sk).strip()
    tid = _thread_id_from_runtime(runtime)
    if not tid:
        return ""
    try:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        return find_session_key_by_thread_id(tid) or ""
    except Exception:
        return ""


def _model_name_from_runtime(runtime: Runtime | None) -> str | None:
    """Extract session model_name from runtime context.

    Works for both dict context and LeadAgentRuntimeContext dataclass (both have .get()).
    Falls back to langgraph get_config() if runtime context is empty.
    """
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
    # DB fallback: thread_id → session → model_name
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


def _messages_from_request(request: ModelRequest) -> list[BaseMessage]:
    from evoflow.agents.middlewares.model_request_messages import messages_from_model_request

    return messages_from_model_request(request)


def _request_model_name(request: ModelRequest) -> str | None:
    """Resolve the model name from request fields, falling back to runtime context."""
    for attr in ("model_name", "model"):
        val = getattr(request, attr, None)
        if isinstance(val, str) and val.strip():
            return val.strip()
        # langchain ChatModel instances expose ``model`` or ``model_name`` properties
        if val is not None:
            for inner in ("model_name", "model"):
                name = getattr(val, inner, None)
                if isinstance(name, str) and name.strip():
                    return name.strip()
    return _model_name_from_runtime(getattr(request, "runtime", None))


class _request_token_scope:
    """Context manager: bind the right tokenizer + real overhead for this call.

    Computes the real (system prompt + tool schema) token cost once and pushes
    it into ``estimate_gate_tokens``'s contextvar so all downstream gate /
    plan calls see the actual prompt budget instead of the legacy 4096 guess.
    Also sets the active model so ``count_text_tokens`` picks ``o200k_base``
    for GPT-4o / o1 / GPT-5 and ``cl100k_base`` for everything else.
    """

    __slots__ = ("_request", "_model_scope", "_overhead_token", "_meta_token")

    def __init__(self, request: ModelRequest) -> None:
        self._request = request
        self._model_scope: token_model_scope | None = None
        self._overhead_token = None
        self._meta_token = None

    def __enter__(self) -> _request_token_scope:
        model_name = _request_model_name(self._request)
        self._model_scope = token_model_scope(model_name)
        self._model_scope.__enter__()
        try:
            estimate = estimate_model_call_overhead(self._request, model=model_name)
            overhead = estimate.total
            self._meta_token = set_gate_overhead_meta(estimate.to_meta())
        except Exception:  # pragma: no cover - never let estimation crash the turn
            logger.debug("token overhead estimation failed; falling back to default", exc_info=True)
            overhead = 0
            self._meta_token = set_gate_overhead_meta(None)
        if overhead > 0:
            self._overhead_token = set_gate_overhead_tokens(overhead)
        return self

    def __exit__(self, *exc: object) -> None:
        if self._meta_token is not None:
            try:
                reset_gate_overhead_meta(self._meta_token)
            except Exception:
                pass
            self._meta_token = None
        if self._overhead_token is not None:
            try:
                reset_gate_overhead_tokens(self._overhead_token)
            except Exception:
                pass
            self._overhead_token = None
        if self._model_scope is not None:
            self._model_scope.__exit__(*exc)
            self._model_scope = None


def _use_background_llm() -> bool:
    cfg = get_summarization_config()
    return bool(cfg.enabled and cfg.compaction_background_llm)


def _prepare_compaction(
    messages: list[BaseMessage],
    runtime: Runtime | None,
) -> tuple[list[BaseMessage], str, str, int, dict[str, Any], dict[str, Any], dict[str, Any], str | None] | None:
    if len(messages) < 2:
        return None
    if not get_summarization_config().enabled:
        return None

    settings = get_compaction_settings()
    model_name = _model_name_from_runtime(runtime)
    context_length = resolve_model_context_length(model_name)
    thread_id = _thread_id_from_runtime(runtime)
    session_key = _session_key_from_runtime(runtime)

    trigger_policy = {
        "compaction_cooldown_seconds": settings.compaction_cooldown_seconds,
        "compaction_hysteresis_enabled": settings.compaction_hysteresis_enabled,
        "compaction_release_ratio": settings.compaction_release_ratio,
    }
    compress_policy = {
        **trigger_policy,
        "compaction_min_middle_tokens": settings.compaction_min_middle_tokens,
        "compaction_trigger_message_count": settings.compaction_trigger_message_count,
    }
    plan_kw = {
        "context_length": context_length,
        "threshold_ratio": settings.threshold_ratio,
        "aggressive_ratio": settings.aggressive_ratio,
        "protect_first_n": settings.protect_first_n,
        "protect_tail_messages": settings.protect_tail_messages,
        "protect_tail_tool_rounds": settings.protect_tail_tool_rounds,
    }
    return messages, thread_id, session_key, context_length, trigger_policy, compress_policy, plan_kw, model_name


def _apply_tool_history_merge(
    messages: list[BaseMessage],
    *,
    thread_id: str,
    prior_tool_history_blocks: list[str] | None = None,
) -> tuple[list[BaseMessage], bool]:
    aged, bg_jobs = apply_tool_history_fast(
        messages,
        thread_id=thread_id,
        prior_tool_history_blocks=prior_tool_history_blocks,
    )
    if bg_jobs:
        get_tool_history_summary_queue().enqueue(bg_jobs)
    if aged is not None:
        logger.info(
            "Context compaction tool-history merge thread=%s msgs %d→%d bg_jobs=%d",
            thread_id[:12],
            len(messages),
            len(aged),
            len(bg_jobs),
        )
        return aged, True
    return messages, False


def _enqueue_compaction_job(job: Any | None) -> None:
    if job is not None:
        get_context_compaction_queue().enqueue(job)


def _block_reason_allows_force_relax(block_reason: str | None) -> bool:
    """Only structural protect failures benefit from a force retry — not min message count."""
    if not block_reason:
        return False
    text = str(block_reason).strip().lower()
    if text.startswith("message_count ") or text.startswith("too_few_messages"):
        return False
    return True


def _needs_aggressive_second_pass(
    messages: list[BaseMessage],
    *,
    plan_kw: dict[str, Any],
) -> bool:
    snap = compaction_token_snapshot(messages, context_length=plan_kw["context_length"])
    aggressive_threshold = compression_threshold_tokens(
        plan_kw["context_length"],
        aggressive=True,
        threshold_ratio=plan_kw["threshold_ratio"],
        aggressive_ratio=plan_kw["aggressive_ratio"],
    )
    return int(snap.get("gate_tokens") or 0) >= aggressive_threshold


def _pass1_reduced_gate_tokens(
    before: list[BaseMessage],
    after: list[BaseMessage],
    *,
    context_length: int,
) -> bool:
    b = compaction_token_snapshot(before, context_length=context_length)
    a = compaction_token_snapshot(after, context_length=context_length)
    return int(a.get("gate_tokens") or 0) < int(b.get("gate_tokens") or 0)


def _pass1_saved_enough(
    before: list[BaseMessage],
    after: list[BaseMessage],
    *,
    context_length: int,
    min_saved_ratio: float = 0.10,
) -> bool:
    b = compaction_token_snapshot(before, context_length=context_length)
    a = compaction_token_snapshot(after, context_length=context_length)
    if b["gate_tokens"] <= 0:
        return False
    saved_ratio = (b["gate_tokens"] - a["gate_tokens"]) / b["gate_tokens"]
    return saved_ratio >= min_saved_ratio


async def _compress_once_async(
    messages: list[BaseMessage],
    *,
    thread_id: str,
    session_key: str,
    compress_policy: dict[str, Any],
    plan_kw: dict[str, Any],
    aggressive: bool = False,
    force: bool = False,
    pass_label: str = "",
    model_name: str | None = None,
    record_turn_mark: bool = False,
) -> tuple[list[BaseMessage], bool]:
    label = pass_label or ("pass2-aggressive" if aggressive else "pass1")
    set_compress_pass_label(label)
    # Hot path: sync compress LLM + immediate DB persist before main model continues.
    return await _engine.compress_messages(
        messages,
        thread_id=thread_id,
        aggressive=aggressive,
        force=force,
        session_key=session_key or None,
        record_turn_mark=record_turn_mark,
        skip_trigger_check=True,
        **compress_policy,
        **plan_kw,
        model_name=model_name,
    )


async def _compress_with_followup_async(
    messages: list[BaseMessage],
    *,
    thread_id: str,
    session_key: str,
    compress_policy: dict[str, Any],
    plan_kw: dict[str, Any],
    force: bool = False,
    model_name: str | None = None,
) -> tuple[list[BaseMessage], bool, list[str]]:
    ctx_len = plan_kw["context_length"]
    passes: list[str] = []
    before_gate_tokens = compaction_token_snapshot(messages, context_length=ctx_len)["gate_tokens"]
    trigger_cache = get_compaction_trigger_cache()
    if not trigger_cache.try_acquire_compress(thread_id):
        logger.info(
            "[context-compaction] skip compress_in_flight thread=%s",
            thread_id[:16],
        )
        return messages, False, []
    emit_compaction_start(thread_id=thread_id)
    compaction_started = True
    try:
        compressed, changed = await _compress_once_async(
            messages,
            thread_id=thread_id,
            session_key=session_key,
            compress_policy=compress_policy,
            plan_kw=plan_kw,
            aggressive=False,
            force=force,
            model_name=model_name,
            record_turn_mark=False,
        )
        if changed:
            log_compaction_pass_result(
                messages,
                compressed,
                context_length=ctx_len,
                thread_id=thread_id,
                model_name=model_name,
                pass_label="pass1",
            )
            passes.append("pass1")
        if changed and passes:
            after_snap = compaction_token_snapshot(compressed, context_length=ctx_len)
            _engine.mark_compress_completed(
                thread_id,
                before_gate_tokens=before_gate_tokens,
                after_gate_tokens=after_snap["gate_tokens"],
                message_count=len(messages),
                session_key=session_key or None,
            )
        return compressed, changed, passes
    finally:
        trigger_cache.release_compress(thread_id)
        if compaction_started:
            emit_compaction_end(thread_id=thread_id)


def _run_async_on_fresh_loop(coro: Awaitable[Any]) -> Any:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        try:
            loop.run_until_complete(loop.shutdown_asyncgens())
        except Exception:
            pass
        try:
            loop.run_until_complete(loop.shutdown_default_executor())
        except Exception:
            pass
        loop.close()
        asyncio.set_event_loop(None)


def _begin_compaction_pass(
    typed: list[BaseMessage],
    *,
    thread_id: str,
    session_key: str,
) -> tuple[list[BaseMessage], list[str]]:
    stripped, _summary_bodies, tool_history_bodies = partition_compaction_artifacts(typed)
    # Compaction summary SSOT is evoflow_chat_messages — never re-persist bodies stripped
    # from hydrated runtime messages (that feedback loop created duplicate summary rows).
    prior_blocks = _engine.load_tool_history_blocks(thread_id, session_key=session_key or None)
    if tool_history_bodies:
        seen = set(prior_blocks)
        for block in tool_history_bodies:
            if block not in seen:
                prior_blocks.append(block)
                seen.add(block)
    return stripped, prior_blocks


def _finalize_compaction_messages(messages: list[BaseMessage]) -> list[BaseMessage]:
    return strip_image_base64_from_messages(dedupe_compaction_artifacts(messages))


def _gate_log_kwargs(settings, plan_kw: dict[str, Any], compress_policy: dict[str, Any] | None = None) -> dict[str, Any]:
    cp = compress_policy or {}
    return {
        "protect_first_n": settings.protect_first_n,
        "protect_tail_messages": settings.protect_tail_messages,
        "protect_tail_tool_rounds": settings.protect_tail_tool_rounds,
        "compaction_cooldown_seconds": float(cp.get("compaction_cooldown_seconds", settings.compaction_cooldown_seconds)),
        "compaction_hysteresis_enabled": bool(
            cp.get("compaction_hysteresis_enabled", settings.compaction_hysteresis_enabled),
        ),
        "compaction_trigger_message_count": int(
            cp.get("compaction_trigger_message_count", settings.compaction_trigger_message_count),
        ),
        **{k: plan_kw[k] for k in ("context_length", "threshold_ratio", "aggressive_ratio")},
    }


def _emit_stream_context_usage(
    original: list[BaseMessage],
    final: list[BaseMessage] | None,
    *,
    plan_kw: dict[str, Any],
    note: str,
    session_key: str = "",
    thread_id: str = "",
) -> None:
    ctx = plan_kw["context_length"]
    before_snap = compaction_token_snapshot(original, context_length=ctx)
    after_msgs = final if final is not None else original
    after_snap = compaction_token_snapshot(after_msgs, context_length=ctx)
    saved = before_snap["gate_tokens"] - after_snap["gate_tokens"]
    _CONTEXT_USAGE_EMITTED_THIS_CALL.set(True)
    emit_context_usage(
        used_tokens=after_snap["gate_tokens"],
        window_tokens=ctx,
        message_count=after_snap["message_count"],
        before_tokens=before_snap["gate_tokens"] if saved > 0 else None,
        compacted=saved > 0,
        note=note,
        session_key=session_key or None,
        thread_id=thread_id or None,
        system_tokens=after_snap.get("system_tokens"),
        tools_tokens=after_snap.get("tools_tokens"),
        message_tokens=after_snap.get("history_tokens"),
        tool_count=after_snap.get("tool_count"),
    )


def _emit_bound_model_context_usage(request: ModelRequest, *, note: str = "model_bound") -> None:
    """Emit gate snapshot for the exact payload bound for this model call (every main turn)."""
    if _CONTEXT_USAGE_EMITTED_THIS_CALL.get():
        return
    msgs = _messages_from_request(request)
    if not msgs:
        return
    prepared = _prepare_compaction(msgs, request.runtime)
    if prepared is None:
        return
    _, thread_id, session_key, _, _, _, plan_kw, _ = prepared
    snap = compaction_token_snapshot(msgs, context_length=plan_kw["context_length"])
    _CONTEXT_USAGE_EMITTED_THIS_CALL.set(True)
    emit_context_usage(
        used_tokens=snap["gate_tokens"],
        window_tokens=plan_kw["context_length"],
        message_count=snap["message_count"],
        before_tokens=None,
        compacted=False,
        note=note,
        session_key=session_key or None,
        thread_id=thread_id or None,
        system_tokens=snap.get("system_tokens"),
        tools_tokens=snap.get("tools_tokens"),
        message_tokens=snap.get("history_tokens"),
        tool_count=snap.get("tool_count"),
    )


def _ai_message_from_model_call_result(result: Any) -> AIMessage | None:
    """Resolve the assistant turn from ``wrap_model_call`` return value.

    ``ModelCallResult`` is ``ModelResponse | AIMessage``; ``ModelResponse``
    exposes ``result: list[BaseMessage]``.
    """
    if result is None:
        return None
    if isinstance(result, AIMessage):
        return result
    inner = getattr(result, "result", None)
    if isinstance(inner, AIMessage):
        return inner
    if isinstance(inner, list):
        for m in reversed(inner):
            if isinstance(m, AIMessage):
                return m
    return None


def _emit_post_model_context_usage(result: ModelCallResult, request: ModelRequest) -> None:
    """Re-emit ``context_usage`` with the real API ``input_tokens`` after the model returns.

    Overrides the pre-model tiktoken estimate (``_emit_bound_model_context_usage``)
    so the UI ring reflects the vendor's actual token count.
    """
    ai_msg = _ai_message_from_model_call_result(result)
    if ai_msg is None:
        logger.debug("[post-model-ctx] no AIMessage in result, skipping")
        return
    usage = infer_usage_metadata_for_ai_message(ai_msg)
    if not usage:
        logger.debug("[post-model-ctx] no usage on AIMessage, skipping (ai_msg.id=%s)", getattr(ai_msg, "id", "?"))
        return
    real_input_tokens = int(usage.get("input_tokens", 0) or 0)
    if real_input_tokens <= 0:
        logger.debug("[post-model-ctx] input_tokens=0, skipping (usage=%s)", usage)
        return
    # runtime ``last_token_usage.total_tokens`` — same number for UI ring + compact gate.
    real_total = int(usage.get("total_tokens", 0) or 0)
    real_output = int(usage.get("output_tokens", 0) or 0)
    api_active = real_total if real_total > 0 else real_input_tokens + max(0, real_output)
    if api_active <= 0:
        api_active = real_input_tokens
    msgs = _messages_from_request(request)
    session_key = ""
    thread_id = ""
    context_length = 0
    prepared = _prepare_compaction(msgs, request.runtime)
    if prepared is not None:
        _, thread_id, session_key, _, _, _, plan_kw, _ = prepared
        context_length = plan_kw["context_length"]
    else:
        runtime = request.runtime
        model_name = _model_name_from_runtime(runtime) if runtime is not None else None
        context_length = resolve_model_context_length(model_name)
        session_key = _session_key_from_runtime(runtime) if runtime is not None else ""
        thread_id = _thread_id_from_runtime(runtime) if runtime is not None else ""
    if context_length <= 0:
        logger.debug("[post-model-ctx] context_length=0, skipping")
        return
    logger.info(
        "[post-model-ctx] re-emitting context_usage used_tokens=%d "
        "(runtime total/active, note=after_model, session=%s, input=%d output=%d)",
        api_active,
        (session_key or "")[:24],
        real_input_tokens,
        real_output,
    )
    # Occupancy numerator = runtime active context (total), not input-only.
    snap = compaction_token_snapshot(msgs, context_length=context_length) if msgs else {}
    emit_context_usage(
        used_tokens=api_active,
        window_tokens=context_length,
        message_count=len(msgs),
        before_tokens=None,
        compacted=False,
        note="after_model",
        session_key=session_key or None,
        thread_id=thread_id or None,
        system_tokens=snap.get("system_tokens") if isinstance(snap, dict) else None,
        tools_tokens=snap.get("tools_tokens") if isinstance(snap, dict) else None,
        message_tokens=snap.get("history_tokens") if isinstance(snap, dict) else None,
        tool_count=snap.get("tool_count") if isinstance(snap, dict) else None,
        api_active_tokens=api_active,
    )


def _emit_ephemeral_model_summary(
    original: list[BaseMessage],
    final: list[BaseMessage],
    *,
    thread_id: str,
    session_key: str,
    model_name: str | None,
    plan_kw: dict[str, Any],
    note: str,
    passes: list[str] | None = None,
) -> None:
    log_compaction_model_payload(
        original,
        final,
        context_length=plan_kw["context_length"],
        thread_id=thread_id,
        model_name=model_name,
        passes=passes,
        note=note,
    )
    b = compaction_token_snapshot(original, context_length=plan_kw["context_length"])
    a = compaction_token_snapshot(final, context_length=plan_kw["context_length"])
    saved = b["gate_tokens"] - a["gate_tokens"]
    set_compaction_snapshot_for_main_call(
        before_gate_tokens=b["gate_tokens"],
        after_gate_tokens=a["gate_tokens"],
        before_message_count=b["message_count"],
        after_message_count=a["message_count"],
        passes=passes,
        note=note,
        compacted=saved > 0,
    )
    _emit_stream_context_usage(
        original,
        final,
        plan_kw=plan_kw,
        note=note,
        session_key=session_key,
        thread_id=thread_id,
    )


def _prefer_db_hydrated_if_stale_checkpoint(
    messages: list[BaseMessage],
    *,
    session_key: str,
    runtime: Runtime | None,
    thread_id: str = "",
) -> tuple[list[BaseMessage], bool]:
    """Replace stale pre-compact checkpoint history with DB ``[bridge][summary][tail]``.

    Compaction is ephemeral (request.override only). LangGraph checkpoints can keep the
    full pre-compact transcript; the next hop then looks like a massive refill and
    re-triggers ``same_turn_over_aggressive_threshold`` / ``over_threshold``. When DB
    already has ``conversation_summary`` but *messages* do not, use the hydration stitch.
    """
    sk = str(session_key or "").strip()
    if not sk or len(messages) < 8:
        return messages, False
    if transcript_has_conversation_summary(messages):
        return messages, False
    try:
        from evoflow.persistence.chat_message_repositories import find_latest_compaction_seq

        if find_latest_compaction_seq(sk) is None:
            return messages, False
    except Exception:
        logger.debug("stale-checkpoint: compaction_seq lookup failed session=%s", sk[:24], exc_info=True)
        return messages, False

    try:
        from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
            _collect_missing_state_humans,
            _extract_tool_approval_replay_messages,
            load_model_messages_for_session,
        )

        # Always stitch from latest summary — do not pass proactive round_id here.
        # round_id hydration used to dump ≤500 raw round rows and skip the summary,
        # which re-inflated gate tokens and re-triggered compress every hop.
        hydrated = load_model_messages_for_session(sk, round_id=None)
    except Exception:
        logger.warning(
            "[context-compaction] stale-checkpoint DB hydrate failed session=%s thread=%s",
            sk[:24],
            str(thread_id or "")[:16],
            exc_info=True,
        )
        return messages, False

    if not hydrated or len(hydrated) >= len(messages):
        return messages, False
    if not transcript_has_conversation_summary(hydrated):
        # Hydration without a summary is not a safe substitute for checkpoint history.
        return messages, False

    merged = list(hydrated)
    try:
        missing = _collect_missing_state_humans(hydrated, messages)
        if missing:
            merged.extend(missing)
        replay = _extract_tool_approval_replay_messages(messages)
        if replay:
            merged.extend(replay)
    except Exception:
        logger.debug("stale-checkpoint merge helpers failed", exc_info=True)

    if len(merged) >= len(messages) or not transcript_has_conversation_summary(merged):
        return messages, False

    logger.info(
        "[context-compaction] stale checkpoint → DB hydrate session=%s thread=%s %d→%d msgs "
        "(reason=db_has_summary_checkpoint_lacks_it)",
        sk[:32],
        str(thread_id or "")[:16],
        len(messages),
        len(merged),
    )
    try:
        from evoflow.observability.compaction_file_log import log_compaction_trace

        log_compaction_trace(
            "checkpoint陈旧改用DB",
            thread_id=thread_id,
            session_key=sk,
            reason="db_has_summary_checkpoint_lacks_it",
            message_count=len(messages),
            msgs_after_fold=len(merged),
            note="skip recompress; use hydration stitch",
        )
    except Exception:
        pass
    return merged, True


async def build_ephemeral_model_messages(
    messages: list[BaseMessage],
    runtime: Runtime | None,
    *,
    force: bool = False,
) -> list[BaseMessage] | None:
    """Fold transcript for the model only; returns None when unchanged."""
    if consume_skip_compaction_once():
        return None
    prepared = _prepare_compaction(messages, runtime)
    if prepared is None:
        return None
    typed, thread_id, session_key, _ctx, _trigger_policy, compress_policy, plan_kw, model_name = prepared
    settings = get_compaction_settings()

    # Safety net: LangGraph checkpoint may still hold pre-compact history while
    # evoflow_chat_messages already has conversation_summary. Prefer DB stitch so
    # we do not re-invoke compress LLM on the stale 500+ message checkpoint.
    typed, used_db_hydrate = _prefer_db_hydrated_if_stale_checkpoint(
        typed,
        session_key=session_key,
        runtime=runtime,
        thread_id=thread_id,
    )

    # DB already has a folded summary and we swapped off the stale checkpoint —
    # never invoke compress LLM again this hop (gate would still see inflated
    # tokens if it ran on the pre-swap list, or thrash on tool follow-ups).
    if used_db_hydrate and transcript_has_conversation_summary(typed):
        try:
            from evoflow.observability.compaction_file_log import count_message_rounds, log_compaction_trace

            snap = compaction_token_snapshot(typed, context_length=plan_kw["context_length"])
            log_compaction_trace(
                "模型调用前",
                thread_id=thread_id,
                session_key=session_key,
                model_name=model_name,
                force=force,
                context_length=plan_kw["context_length"],
                model_context=f"{plan_kw['context_length'] // 1000}k",
                gate_tokens=snap["gate_tokens"],
                history_tokens=snap["history_tokens"],
                overhead_tokens=snap["overhead_tokens"],
                pct_of_context=snap["pct_of_context"],
                note="stale_checkpoint_db_hydrate_passthrough",
                **count_message_rounds(typed),
            )
            log_compaction_trace(
                "未触发压缩",
                thread_id=thread_id,
                session_key=session_key,
                reason="stale_checkpoint_db_hydrate_passthrough",
                message_count=len(typed),
                gate_tokens=snap["gate_tokens"],
            )
        except Exception:
            pass
        _emit_stream_context_usage(
            typed,
            None,
            plan_kw=plan_kw,
            note="stale_checkpoint_db_hydrate_passthrough",
            session_key=session_key,
            thread_id=thread_id,
        )
        final = _finalize_compaction_messages(typed)
        return final if final is not None else typed

    try:
        from evoflow.observability.compaction_file_log import count_message_rounds, log_compaction_trace

        snap = compaction_token_snapshot(typed, context_length=plan_kw["context_length"])
        log_compaction_trace(
            "模型调用前",
            thread_id=thread_id,
            session_key=session_key,
            model_name=model_name,
            force=force,
            context_length=plan_kw["context_length"],
            model_context=f"{plan_kw['context_length'] // 1000}k",
            gate_tokens=snap["gate_tokens"],
            history_tokens=snap["history_tokens"],
            overhead_tokens=snap["overhead_tokens"],
            system_tokens=snap.get("system_tokens"),
            tools_tokens=snap.get("tools_tokens"),
            tool_count=snap.get("tool_count"),
            pct_of_context=snap["pct_of_context"],
            background_llm=_use_background_llm(),
            note="stale_checkpoint_db_hydrate" if used_db_hydrate else None,
            **count_message_rounds(typed),
        )
    except Exception:
        logger.debug("compaction trace log failed (model_call_start)", exc_info=True)

    gate_kw = _gate_log_kwargs(settings, plan_kw, compress_policy)

    gate = log_compaction_gate(
        typed,
        thread_id=thread_id,
        session_key=session_key,
        model_name=model_name,
        phase="before_conversation_fold",
        force=force,
        **gate_kw,
    )

    if should_passthrough_db_hydrated_transcript(typed, gate, force=force):
        skip_reason = str(gate.get("trigger_reason") or "hydrated_passthrough")
        log_compaction_skipped(
            typed,
            context_length=plan_kw["context_length"],
            thread_id=thread_id,
            model_name=model_name,
            threshold=gate["threshold"],
            reason=skip_reason,
        )
        _emit_stream_context_usage(
            typed,
            None,
            plan_kw=plan_kw,
            note="hydrated_passthrough",
            session_key=session_key,
            thread_id=thread_id,
        )
        final = _finalize_compaction_messages(typed)
        # Must return hydrated messages when we swapped off a stale checkpoint,
        # even if finalize is a no-op — otherwise the model still sees 500+ msgs.
        if final is not typed:
            return final
        return typed if used_db_hydrate else None

    stripped, tool_history_bodies = _begin_compaction_pass(
        typed,
        thread_id=thread_id,
        session_key=session_key,
    )

    log_compaction_gate(
        stripped,
        thread_id=thread_id,
        session_key=session_key,
        model_name=model_name,
        phase="before_tool_merge",
        evaluate_policy=False,
        **gate_kw,
    )

    working, tool_changed = _apply_tool_history_merge(
        stripped,
        thread_id=thread_id,
        prior_tool_history_blocks=tool_history_bodies or None,
    )

    if tool_changed:
        gate = log_compaction_gate(
            working,
            thread_id=thread_id,
            session_key=session_key,
            model_name=model_name,
            phase="before_conversation_fold",
            force=force,
            **gate_kw,
        )

    if not force and not gate["should_trigger"]:
        if transcript_has_conversation_summary(typed):
            log_compaction_skipped(
                working,
                context_length=plan_kw["context_length"],
                thread_id=thread_id,
                model_name=model_name,
                threshold=gate["threshold"],
                reason="hydrated_no_refold",
            )
            _emit_stream_context_usage(
                typed,
                None,
                plan_kw=plan_kw,
                note="hydrated_passthrough",
                session_key=session_key,
                thread_id=thread_id,
            )
            final = _finalize_compaction_messages(typed)
            if final is not typed:
                return final
            return typed if used_db_hydrate else None
        if gate.get("should_refold_cached") or gate.get("token_over_threshold"):
            refold = _engine.try_refold_with_cached_summary(
                working,
                thread_id=thread_id,
                **{k: plan_kw[k] for k in ("context_length", "threshold_ratio", "aggressive_ratio")},
                protect_first_n=settings.protect_first_n,
                protect_tail_messages=settings.protect_tail_messages,
                protect_tail_tool_rounds=settings.protect_tail_tool_rounds,
            )
            if refold is None and gate.get("token_over_threshold"):
                hydrated = _engine.try_fold_hydrated_transcript(
                    working,
                    thread_id=thread_id,
                    session_key=session_key,
                    protect_tail_messages=settings.protect_tail_messages,
                )
                refold = hydrated
            if refold is not None:
                final = _finalize_compaction_messages(refold[0])
                _emit_ephemeral_model_summary(
                    typed,
                    final,
                    thread_id=thread_id,
                    session_key=session_key,
                    model_name=model_name,
                    plan_kw=plan_kw,
                    note="cooldown_refold" if gate.get("should_refold_cached") else "hydrated_transcript_fold",
                )
                return final
            # Refold failed during cooldown — if tokens still over threshold,
            # force a fold to avoid sending the full uncompressed history to the model.
            if gate.get("token_over_threshold"):
                logger.warning(
                    "[context-compaction] refold failed during cooldown; "
                    "force fold to prevent %d msgs from hitting model unfolded",
                    len(working),
                )
                compressed, changed, passes = await _compress_with_followup_async(
                    working,
                    thread_id=thread_id,
                    session_key=session_key,
                    compress_policy=compress_policy,
                    plan_kw=plan_kw,
                    force=True,
                    model_name=model_name,
                )
                if changed:
                    log_compaction_gate(
                        compressed,
                        thread_id=thread_id,
                        model_name=model_name,
                        phase="after_conversation_fold",
                        evaluate_policy=False,
                        **gate_kw,
                    )
                    final = _finalize_compaction_messages(compressed)
                    _emit_ephemeral_model_summary(
                        typed,
                        final,
                        thread_id=thread_id,
                        session_key=session_key,
                        model_name=model_name,
                        plan_kw=plan_kw,
                        note="cooldown_refold_failed_force",
                        passes=passes,
                    )
                    return final
        if gate.get("token_over_threshold") and _block_reason_allows_force_relax(gate.get("block_reason")):
            compressed, changed, passes = await _compress_with_followup_async(
                working,
                thread_id=thread_id,
                session_key=session_key,
                compress_policy=compress_policy,
                plan_kw=plan_kw,
                force=True,
                model_name=model_name,
            )
            if changed:
                log_compaction_gate(
                    compressed,
                    thread_id=thread_id,
                    model_name=model_name,
                    phase="after_conversation_fold",
                    evaluate_policy=False,
                    **gate_kw,
                )
                final = _finalize_compaction_messages(compressed)
                _emit_ephemeral_model_summary(
                    typed,
                    final,
                    thread_id=thread_id,
                    session_key=session_key,
                    model_name=model_name,
                    plan_kw=plan_kw,
                    note="relaxed-protect",
                    passes=passes,
                )
                return final
        if not tool_changed:
            skip_reason = gate.get("block_reason") or "below_threshold"
            log_compaction_skipped(
                working,
                context_length=plan_kw["context_length"],
                thread_id=thread_id,
                model_name=model_name,
                threshold=gate["threshold"],
                reason=skip_reason,
            )
            _emit_stream_context_usage(typed, None, plan_kw=plan_kw, note=skip_reason, session_key=session_key, thread_id=thread_id)
            _stripped = strip_image_base64_from_messages(working)
            if _stripped is not working:
                return _stripped
            return working if used_db_hydrate else None
        final = _finalize_compaction_messages(working)
        _emit_ephemeral_model_summary(
            typed,
            final,
            thread_id=thread_id,
            session_key=session_key,
            model_name=model_name,
            plan_kw=plan_kw,
            note="tool_merge_only",
        )
        return final

    compressed, changed, passes = await _compress_with_followup_async(
        working,
        thread_id=thread_id,
        session_key=session_key,
        compress_policy=compress_policy,
        plan_kw=plan_kw,
        force=force,
        model_name=model_name,
    )
    if changed:
        log_compaction_gate(
            compressed,
            thread_id=thread_id,
            model_name=model_name,
            phase="after_conversation_fold",
            evaluate_policy=False,
            **gate_kw,
        )
        final = _finalize_compaction_messages(compressed)
        _emit_ephemeral_model_summary(
            typed,
            final,
            thread_id=thread_id,
            session_key=session_key,
            model_name=model_name,
            plan_kw=plan_kw,
            note="conversation_fold",
            passes=passes,
        )
        return final

    if not tool_changed:
        log_compaction_skipped(
            working,
            context_length=plan_kw["context_length"],
            thread_id=thread_id,
            model_name=model_name,
            threshold=gate["threshold"],
            reason="fold_unchanged",
        )
        _emit_stream_context_usage(typed, None, plan_kw=plan_kw, note="fold_unchanged", session_key=session_key, thread_id=thread_id)
        _stripped = strip_image_base64_from_messages(working)
        return _stripped if _stripped is not working else None
    final = _finalize_compaction_messages(working)
    _emit_ephemeral_model_summary(
        typed,
        final,
        thread_id=thread_id,
        session_key=session_key,
        model_name=model_name,
        plan_kw=plan_kw,
        note="tool_merge_only",
    )
    return final


def build_ephemeral_model_messages_sync(
    messages: list[BaseMessage],
    runtime: Runtime | None,
    *,
    force: bool = False,
) -> list[BaseMessage] | None:
    coro = build_ephemeral_model_messages(messages, runtime, force=force)
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return _run_async_on_fresh_loop(coro)
    fut = _COMPRESS_POOL.submit(_run_async_on_fresh_loop, coro)
    try:
        return fut.result(timeout=_SYNC_COMPACTION_TIMEOUT_S)
    except _FutureTimeoutError:
        # Compaction LLM is wedged or slow. Cancelling the future only stops the
        # wrapper from blocking us; the inner coroutine keeps running on the pool
        # thread until it completes. Return ``None`` so the caller treats the
        # batch as "no fold" and lets the main model call proceed with the raw
        # message list instead of failing the whole turn.
        try:
            fut.cancel()
        except Exception:  # noqa: BLE001 - best-effort cleanup
            pass
        logger.warning(
            "Sync compaction timed out after %.1fs; proceeding without ephemeral fold",
            _SYNC_COMPACTION_TIMEOUT_S,
        )
        try:
            from evoflow.observability.compaction_file_log import log_compaction_trace

            log_compaction_trace(
                "同步压缩超时",
                level=logging.WARNING,
                error=f"timeout after {_SYNC_COMPACTION_TIMEOUT_S}s",
            )
        except Exception:
            pass
        try:
            from evoflow.observability.thread_run_queue_log import log_thread_run_queue

            log_thread_run_queue(
                "sync_compaction_timeout",
                level=logging.WARNING,
                timeout_s=_SYNC_COMPACTION_TIMEOUT_S,
                note="compress pool future timed out; main turn proceeds without fold "
                "(pool thread may still hold a worker until LLM returns)",
            )
        except Exception:
            pass
        return None
    except Exception:
        logger.exception("Sync compaction raised; proceeding without ephemeral fold")
        try:
            from evoflow.observability.compaction_file_log import log_compaction_trace

            log_compaction_trace(
                "同步压缩异常",
                level=logging.ERROR,
                error="sync compaction raised",
            )
        except Exception:
            pass
        return None


def emergency_compress_messages(
    messages: list[BaseMessage],
    runtime: Runtime | None,
) -> tuple[list[BaseMessage], bool]:
    if not get_summarization_config().enabled:
        return messages, False
    typed = [m for m in messages if isinstance(m, BaseMessage)]
    if len(typed) < 2:
        return messages, False
    folded = build_ephemeral_model_messages_sync(typed, runtime, force=True)
    if folded is None:
        return messages, False
    return folded, True


async def emergency_compress_messages_async(
    messages: list[BaseMessage],
    runtime: Runtime | None,
) -> tuple[list[BaseMessage], bool]:
    if not get_summarization_config().enabled:
        return messages, False
    typed = [m for m in messages if isinstance(m, BaseMessage)]
    if len(typed) < 2:
        return messages, False
    folded = await build_ephemeral_model_messages(typed, runtime, force=True)
    if folded is None:
        return messages, False
    return folded, True


def _record_fold_outcome(
    original: list[BaseMessage],
    folded: list[BaseMessage],
    runtime: Runtime | None,
    *,
    plan_kw: dict[str, Any] | None = None,
) -> None:
    """Record fold metrics only; summary rows are written via ``set_previous_summary`` → chat_messages."""
    ctx_len = int(plan_kw["context_length"]) if plan_kw else resolve_model_context_length(_model_name_from_runtime(runtime))
    before_snap = compaction_token_snapshot(original, context_length=ctx_len)
    after_snap = compaction_token_snapshot(folded, context_length=ctx_len)
    before_n = len(original)
    after_n = len(folded)
    if after_n != before_n:
        _mark_compaction_folded(before=before_n, after=after_n)
        try:
            from evoflow.agents.memory.standing_freeze import invalidate_standing_memory

            tid = ""
            if isinstance(plan_kw, dict):
                tid = str(plan_kw.get("thread_id") or "").strip()
            invalidate_standing_memory(tid or None)
        except Exception:
            pass


def _fill_empty_tool_messages(messages: list[BaseMessage]) -> list[BaseMessage]:
    """Replace empty ToolMessage content with a placeholder.

    Many models (e.g. DeepSeek) return output=0 / finish_reason=stop when they
    receive a tool result with empty content, treating it as "nothing to
    respond to". This fills empty ToolMessages with a placeholder so the model
    always has something to work with.
    """
    from langchain_core.messages import ToolMessage

    from evoflow.agents.middlewares.model_request_messages import strip_blank_unnamed_human_messages

    out: list[BaseMessage] = []
    for msg in messages:
        if isinstance(msg, ToolMessage):
            content = getattr(msg, "content", None)
            is_empty = False
            if content is None:
                is_empty = True
            elif isinstance(content, str) and not content.strip():
                is_empty = True
            elif isinstance(content, list) and not any(
                (isinstance(b, str) and b.strip())
                or (isinstance(b, dict) and str(b.get("text") or "").strip())
                for b in content
            ):
                is_empty = True
            if is_empty:
                msg = ToolMessage(
                    content="[Tool completed — no output]",
                    tool_call_id=msg.tool_call_id,
                    name=getattr(msg, "name", None),
                )
        out.append(msg)
    # Drop checkpoint noise: ``[{type:text,text:""}]`` Human rows that inflate vendor payloads.
    return strip_blank_unnamed_human_messages(out)


class ContextCompactionMiddleware(AgentMiddleware[AgentState]):
    """Tool merge + conversation fold applied only at model-call time (not checkpoint)."""

    state_schema = AgentState

    def _maybe_fold_request(self, request: ModelRequest) -> ModelRequest:
        clear_compaction_snapshot()
        messages = _messages_from_request(request)
        if len(messages) < 2:
            return request
        folded = build_ephemeral_model_messages_sync(messages, request.runtime)
        if folded is None:
            return request
        return request.override(messages=folded)

    def _patch_empty_tool_messages(self, request: ModelRequest) -> ModelRequest:
        """Fill empty ToolMessage content to prevent model empty returns.

        Many models (e.g. DeepSeek) return output=0 / finish_reason=stop when
        they receive a tool result with empty content. This patches all empty
        ToolMessages with a placeholder before sending to the model.
        """
        messages = _messages_from_request(request)
        patched = _fill_empty_tool_messages(messages)
        if patched is messages:
            return request
        return request.override(messages=patched)

    def _invoke_model(self, request: ModelRequest, handler) -> ModelCallResult:
        bound_token = _BOUND_MODEL_MESSAGES.set(_messages_from_request(request))
        try:
            return handler(request)
        finally:
            _BOUND_MODEL_MESSAGES.reset(bound_token)

    @override
    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        with _request_token_scope(request):
            _reset_compaction_call_markers()
            req = self._maybe_fold_request(request)
            if req is not request:
                _record_fold_outcome(_messages_from_request(request), _messages_from_request(req), request.runtime)
            # Fill empty ToolMessage content — many models (DeepSeek) return
            # output=0 / finish_reason=stop when they receive an empty tool result.
            # Also drop blank unnamed Human rows (``[{type:text,text:""}]``).
            req = self._patch_empty_tool_messages(req)
            _emit_bound_model_context_usage(req)
            result = self._invoke_model(req, handler)
            _emit_post_model_context_usage(result, req)
            return result

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        with _request_token_scope(request):
            _reset_compaction_call_markers()
            clear_compaction_snapshot()
            messages = _messages_from_request(request)
            if len(messages) < 2:
                req = self._patch_empty_tool_messages(request)
                bound_token = _BOUND_MODEL_MESSAGES.set(_messages_from_request(req))
                try:
                    return await handler(req)
                finally:
                    _BOUND_MODEL_MESSAGES.reset(bound_token)
            folded = await build_ephemeral_model_messages(messages, request.runtime)
            if folded is not None:
                _record_fold_outcome(messages, folded, request.runtime)
            req = request.override(messages=folded) if folded is not None else request
            # Fill empty ToolMessage content — many models (DeepSeek) return
            # output=0 / finish_reason=stop when they receive an empty tool result.
            req = self._patch_empty_tool_messages(req)
            _emit_bound_model_context_usage(req)
            bound_token = _BOUND_MODEL_MESSAGES.set(_messages_from_request(req))
            try:
                result = await handler(req)
                _emit_post_model_context_usage(result, req)
                return result
            finally:
                _BOUND_MODEL_MESSAGES.reset(bound_token)
