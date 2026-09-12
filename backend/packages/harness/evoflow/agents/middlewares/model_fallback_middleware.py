"""Graceful fallback when model API calls fail — returns a user-friendly AIMessage instead of crashing the run."""

from __future__ import annotations

import asyncio
import logging
import random
import re
import time
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest
from langchain_core.messages import AIMessage, BaseMessage
from langgraph.errors import GraphBubbleUp
from langgraph.runtime import Runtime

from evoflow.error_classifier import FailoverReason, classify

logger = logging.getLogger(__name__)

_MAX_RATE_LIMIT_RETRIES = 3
_MAX_SERVER_ERROR_RETRIES = 3
_MAX_BACKOFF_SECONDS = 60.0

_MAX_CREDENTIAL_ROTATIONS = 3
_MAX_MODEL_FALLBACKS = 3

_RETRYABLE_TRANSIENT_REASONS = frozenset(
    {
        FailoverReason.SERVER_ERROR,
        FailoverReason.OVERLOADED,
        FailoverReason.TIMEOUT,
        FailoverReason.CONNECTION_ERROR,
        # 中转站常返回含糊 APIError；classify 已标 retryable=True，这里统一退避重试。
        FailoverReason.UNKNOWN,
    }
)

_AUTH_FAILURE_MESSAGE = (
    "模型 API 认证失败，已尝试轮换所有可用凭证。请检查 API Key 配置或切换到其他模型。"
)

_USER_FRIENDLY_MESSAGE = (
    "模型请求失败：上游模型 API 返回错误。已记录调试信息，你可以重试或切换模型。"
)
_CONNECTION_ERROR_MESSAGE = (
    "模型网络连接异常，无法连接到上游 API 服务。请检查网络状况或稍后重试。"
)
_RATE_LIMIT_USER_MESSAGE = (
    "模型 API 限流（请求过于频繁），已自动重试但仍未成功。请稍等片刻后重试，或切换到其他模型。"
)
_OVERLOADED_USER_MESSAGE = (
    "模型服务当前过载，已自动重试但仍未成功。请稍等片刻后重试，或切换到其他模型。"
)
_CONTEXT_OVERFLOW_USER_MESSAGE = (
    "当前对话上下文已超出模型窗口上限，自动压缩后仍无法继续。"
    "请新开会话、手动压缩上下文，或切换更大窗口的模型后再试。"
)
_BILLING_USER_MESSAGE = (
    "当前模型 API 额度已用尽，无法继续生成回复。请稍后再试、切换其他模型，或升级 API 套餐。"
)
_QUOTA_RESET_AT_RE = re.compile(r"reset at ([^'\"}\]]+)", re.IGNORECASE)
_QUOTA_N_HOUR_RE = re.compile(r"(\d+)\s*-\s*hour", re.IGNORECASE)


def _quota_scope_label(exc: Exception) -> str:
    """e.g. '5小时额度' / '月度额度' / '额度'."""
    text = str(exc or "")
    hm = _QUOTA_N_HOUR_RE.search(text)
    if hm:
        return f"{hm.group(1)}小时额度"
    lower = text.lower()
    if "hourly" in lower and "quota" in lower:
        return "小时额度"
    if "daily" in lower and "quota" in lower:
        return "日额度"
    if "weekly" in lower and "quota" in lower:
        return "周额度"
    if "monthly" in lower and "quota" in lower:
        return "月度额度"
    if "accountquotaexceeded" in lower:
        return "额度"
    return "额度"


def _billing_user_message(exc: Exception) -> str:
    scope = _quota_scope_label(exc)
    match = _QUOTA_RESET_AT_RE.search(str(exc))
    if match:
        reset_at = match.group(1).strip().rstrip(".")
        return (
            f"当前模型 API {scope}已用尽，无法继续生成回复。"
            f"额度将在 {reset_at} 重置；您也可以切换其他模型或升级 API 套餐后重试。"
        )
    if scope != "额度":
        return (
            f"当前模型 API {scope}已用尽，无法继续生成回复。"
            "请稍后再试、切换其他模型，或升级 API 套餐。"
        )
    return _BILLING_USER_MESSAGE


def _calc_backoff_seconds(attempt: int, error: Exception) -> float:
    """Exponential backoff with jitter; honors Retry-After when present. *attempt* is 1-based."""
    backoff_s = 2.0 * (2 ** (attempt - 1))
    jitter_s = random.uniform(0, backoff_s * 0.2)
    total_s = backoff_s + jitter_s

    resp = getattr(error, "response", None)
    if resp is not None and hasattr(resp, "headers"):
        retry_after = resp.headers.get("Retry-After")
        if retry_after:
            try:
                total_s = max(total_s, float(retry_after))
            except (ValueError, TypeError):
                pass

    return min(total_s, _MAX_BACKOFF_SECONDS)


def _user_friendly_message_for_error(exc: Exception) -> str:
    classification = classify(exc)
    if classification.reason == FailoverReason.BILLING:
        return _billing_user_message(exc)
    if classification.reason == FailoverReason.RATE_LIMIT:
        return _RATE_LIMIT_USER_MESSAGE
    if classification.reason == FailoverReason.OVERLOADED:
        return _OVERLOADED_USER_MESSAGE
    if classification.reason in (FailoverReason.CONTEXT_OVERFLOW, FailoverReason.PAYLOAD_TOO_LARGE):
        return _CONTEXT_OVERFLOW_USER_MESSAGE
    if classification.reason == FailoverReason.AUTH:
        return _AUTH_FAILURE_MESSAGE
    if classification.reason == FailoverReason.CONNECTION_ERROR:
        return _CONNECTION_ERROR_MESSAGE
    return _USER_FRIENDLY_MESSAGE


def _retry_reason_label(reason: FailoverReason) -> str:
    return {
        FailoverReason.RATE_LIMIT: "限流",
        FailoverReason.OVERLOADED: "服务过载",
        FailoverReason.SERVER_ERROR: "服务异常",
        FailoverReason.TIMEOUT: "超时",
        FailoverReason.CONNECTION_ERROR: "网络异常",
        FailoverReason.CONTEXT_OVERFLOW: "上下文超限",
        FailoverReason.PAYLOAD_TOO_LARGE: "请求过大",
        FailoverReason.UNKNOWN: "上游异常",
        FailoverReason.AUTH: "认证失败",
        FailoverReason.AUTH_PERMANENT: "认证失败",
        FailoverReason.BILLING: "额度用尽",
        FailoverReason.MODEL_NOT_FOUND: "模型不存在",
        FailoverReason.FORMAT_ERROR: "请求格式错误",
    }.get(reason, "上游异常")


_MARK_UNAVAILABLE_REASONS = frozenset(
    {
        FailoverReason.AUTH,
        FailoverReason.AUTH_PERMANENT,
        FailoverReason.BILLING,
        FailoverReason.MODEL_NOT_FOUND,
        FailoverReason.SERVER_ERROR,
        FailoverReason.CONNECTION_ERROR,
        FailoverReason.OVERLOADED,
        FailoverReason.RATE_LIMIT,
        FailoverReason.TIMEOUT,
        FailoverReason.UNKNOWN,
        FailoverReason.FORMAT_ERROR,
    }
)


def _should_mark_unavailable(reason: FailoverReason) -> bool:
    return reason in _MARK_UNAVAILABLE_REASONS


def _model_display_name(model_name: str) -> str:
    name = str(model_name or "").strip()
    if not name:
        return name
    try:
        from evoflow.config import get_app_config

        mc = get_app_config().get_model_config(name)
        if mc is not None:
            label = str(getattr(mc, "display_name", None) or "").strip()
            if label:
                return label
    except Exception:
        pass
    return name


def _resolve_failed_model_name(exc: Exception, runtime: Runtime | None) -> str:
    model = _extract_model_instance(exc)
    if model is not None:
        primary = str(getattr(model, "_evoflow_primary_model_name", "") or "").strip()
        if primary:
            return primary
    return str(_resolve_model_name(runtime) or "").strip()


def _mark_model_unavailable_for_error(model_name: str, exc: Exception) -> None:
    name = str(model_name or "").strip()
    if not name:
        return
    classification = classify(exc)
    if not _should_mark_unavailable(classification.reason):
        return
    reason = _retry_reason_label(classification.reason)
    try:
        from evoflow.config import reload_models_from_db
        from evoflow.persistence import config_repositories as cfg_repo

        if cfg_repo.mark_model_unavailable(
            name,
            reason=reason,
            code=classification.reason.value,
        ):
            reload_models_from_db()
            logger.warning(
                "Marked model %r unavailable reason=%s code=%s",
                name,
                reason,
                classification.reason.value,
            )
    except Exception:
        logger.debug("mark model unavailable failed name=%s", name, exc_info=True)


def _clear_model_unavailable_quiet(model_name: str) -> None:
    name = str(model_name or "").strip()
    if not name:
        return
    try:
        from evoflow.config import reload_models_from_db
        from evoflow.persistence import config_repositories as cfg_repo

        if cfg_repo.clear_model_unavailable(name):
            reload_models_from_db()
    except Exception:
        logger.debug("clear model unavailable failed name=%s", name, exc_info=True)


def _filter_available_fallback_candidates(candidates: list[str]) -> list[str]:
    out: list[str] = []
    try:
        from evoflow.persistence import config_repositories as cfg_repo

        for name in candidates:
            n = str(name or "").strip()
            if not n:
                continue
            if cfg_repo.is_model_unavailable(n):
                logger.info("Skipping unavailable fallback model %r", n)
                continue
            out.append(n)
    except Exception:
        logger.debug("filter available fallbacks failed", exc_info=True)
        return [str(x).strip() for x in candidates if str(x or "").strip()]
    return out


def _persist_session_model_switch(
    runtime: Runtime | None,
    *,
    from_model: str,
    to_model: str,
    reason: str,
) -> None:
    """Update session model_name, emit SSE notice, and persist MODEL_SWITCH separator."""
    tid = _runtime_thread_id(runtime)
    to_name = str(to_model or "").strip()
    if not to_name:
        return
    from_label = _model_display_name(from_model) or from_model or "原模型"
    to_label = _model_display_name(to_name) or to_name
    reason_text = str(reason or "").strip() or "上游异常"
    sep_text = f"已自动切换至 {to_label} 模型（原模型 {from_label} 不可用：{reason_text}）"
    notice = sep_text

    if tid:
        try:
            from evoflow.persistence import session_repositories as sess_repo

            sk = sess_repo.find_session_key_by_thread_id(tid)
            if sk:
                sess_repo.upsert_session_row(sk, context={"model_name": to_name})
                try:
                    from evoflow.persistence.chat_session_service import (
                        append_message_and_touch_session,
                    )

                    append_message_and_touch_session(
                        sk,
                        role="user",
                        content=f"[MODEL_SWITCH]{sep_text}",
                        thread_id=tid,
                    )
                except Exception:
                    logger.debug(
                        "persist MODEL_SWITCH message failed session=%s",
                        sk,
                        exc_info=True,
                    )
        except Exception:
            logger.debug("session model switch persist failed thread=%s", tid, exc_info=True)

    _emit_user_notice_stream(notice, runtime)
    if tid:
        try:
            from evoflow.observability.agent_activity_stream import emit_agent_activity

            emit_agent_activity(tid, kind="model_fallback", detail=notice, force=True)
        except Exception:
            logger.debug("model_fallback activity emit failed thread=%s", tid, exc_info=True)
        try:
            from langgraph.config import get_stream_writer

            writer = get_stream_writer()
            if writer is not None:
                writer(
                    {
                        "type": "model_fallback_switch",
                        "model_name": to_name,
                        "from_model": str(from_model or ""),
                        "text": notice,
                    }
                )
        except Exception:
            logger.debug("model_fallback_switch stream emit failed thread=%s", tid, exc_info=True)


def _on_fallback_model_succeeded(
    runtime: Runtime | None,
    *,
    primary_name: str,
    fallback_name: str,
    primary_exc: Exception,
) -> None:
    classification = classify(primary_exc)
    reason = _retry_reason_label(classification.reason)
    _mark_model_unavailable_for_error(primary_name, primary_exc)
    _clear_model_unavailable_quiet(fallback_name)
    _persist_session_model_switch(
        runtime,
        from_model=primary_name,
        to_model=fallback_name,
        reason=reason,
    )


def _emit_model_retry_activity(
    runtime: Runtime | None,
    *,
    attempt: int,
    max_attempts: int,
    reason: FailoverReason,
    wait_s: float = 0.0,
    note: str = "",
) -> None:
    """Push retry progress into the live SSE activity lane for the frontend dock."""
    tid = _runtime_thread_id(runtime)
    if not tid:
        return
    label = _retry_reason_label(reason)
    detail = f"系统重试中（{attempt}/{max_attempts}）：{label}"
    if note:
        detail = f"{detail}，{note}"
    elif wait_s > 0:
        detail = f"{detail}，约 {wait_s:.0f}s 后继续"
    try:
        from evoflow.observability.agent_activity_stream import emit_agent_activity

        emit_agent_activity(tid, kind="retrying", detail=detail, force=True)
    except Exception:
        logger.debug("model retry activity emit failed thread=%s", tid, exc_info=True)


def _extract_model_instance(exc: Exception) -> Any | None:
    """Extract the chat model instance attached to a vendor exception."""
    return getattr(exc, "_evoflow_model", None)


def _runtime_thread_id(runtime: Runtime | None) -> str | None:
    if runtime is None:
        return None
    ctx = getattr(runtime, "context", None)
    if isinstance(ctx, dict):
        tid = str(ctx.get("thread_id") or "").strip()
        if tid:
            return tid
    try:
        from langgraph.config import get_config

        cfg = get_config()
        c = cfg.get("configurable") if isinstance(cfg, dict) else {}
        if isinstance(c, dict):
            tid = str(c.get("thread_id") or "").strip()
            if tid:
                return tid
    except Exception:
        pass
    return None


def _runtime_trace_id(runtime: Runtime | None) -> str | None:
    if runtime is None:
        return None
    ctx = getattr(runtime, "context", None)
    if isinstance(ctx, dict):
        tid = str(ctx.get("evf_trace_id") or "").strip()
        if tid:
            return tid
    return None


def _resolve_model_name(runtime: Runtime | None) -> str | None:
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


def _is_model_api_error(exc: Exception) -> bool:
    """Return True for exceptions that originate from the model provider API."""
    cls_name = exc.__class__.__name__
    module = getattr(exc.__class__, "__module__", "").lower()

    if "openai" in module or "anthropic" in module:
        return True

    # HTTP / network errors that commonly wrap model calls
    if cls_name in {
        "APITimeoutError",
        "APIConnectionError",
        "APIStatusError",
        "BadRequestError",
        "InternalServerError",
        "RateLimitError",
        "AuthenticationError",
        "PermissionDeniedError",
        "NotFoundError",
        "UnprocessableEntityError",
        "ConflictError",
        "TimeoutError",
        "ConnectionError",
    }:
        return True

    # LangChain / httpx wrappers
    if "httpx" in module or "langchain" in module:
        return True

    # Walk exception chain for wrapped provider errors
    cause = exc
    seen: set[int] = set()
    while cause is not None and id(cause) not in seen:
        seen.add(id(cause))
        c_module = getattr(cause.__class__, "__module__", "").lower()
        if "openai" in c_module or "anthropic" in c_module:
            return True
        cause = getattr(cause, "__cause__", None) or getattr(cause, "__context__", None)

    return False


def _should_reraise_for_supervisor(runtime: Runtime | None) -> bool:
    """During active task orchestration, model failures must abort the run — not fake AIMessage."""
    tid = _runtime_thread_id(runtime)
    ctx = getattr(runtime, "context", None) if runtime is not None else None
    if isinstance(ctx, dict):
        if ctx.get("is_task_execution") or str(ctx.get("prompt_source") or "").strip() in {
            "goal",
            "goal_controller",
            "hosted_autofollow",
        }:
            return True
    if not tid:
        return False
    try:
        from evoflow.collab.models import CollabPhase
        from evoflow.collab.thread_collab import load_thread_collab_state
        from evoflow.config.paths import get_paths

        st = load_thread_collab_state(get_paths(), tid)
        phase = st.collab_phase.value if isinstance(st.collab_phase, CollabPhase) else str(st.collab_phase or "")
        return phase in {
            CollabPhase.EXECUTING.value,
            CollabPhase.VERIFYING.value,
            CollabPhase.REFLECTING.value,
            CollabPhase.AWAITING_EXEC.value,
        }
    except Exception:
        return False


_OVERFLOW_CONTENT_CHAR_CAP = 12_000


def _hard_shrink_message_contents(messages: list[BaseMessage], *, char_cap: int = _OVERFLOW_CONTENT_CHAR_CAP) -> list[BaseMessage]:
    """Truncate oversized string / text-block payloads that survive fold/truncate."""
    result: list[BaseMessage] | None = None
    for i, msg in enumerate(messages):
        content = getattr(msg, "content", None)
        new_content: Any = content
        changed = False
        if isinstance(content, str) and len(content) > char_cap:
            omit = len(content) - char_cap
            head = max(char_cap // 2, 256)
            tail = max(char_cap - head, 128)
            new_content = f"{content[:head]}\n\n[... {omit} chars omitted after context overflow ...]\n\n{content[-tail:]}"
            changed = True
        elif isinstance(content, list):
            new_blocks: list[Any] = []
            for block in content:
                if isinstance(block, dict) and isinstance(block.get("text"), str) and len(block["text"]) > char_cap:
                    text = block["text"]
                    omit = len(text) - char_cap
                    head = max(char_cap // 2, 256)
                    tail = max(char_cap - head, 128)
                    new_blocks.append(
                        {
                            **block,
                            "text": f"{text[:head]}\n\n[... {omit} chars omitted after context overflow ...]\n\n{text[-tail:]}",
                        }
                    )
                    changed = True
                elif isinstance(block, str) and len(block) > char_cap:
                    omit = len(block) - char_cap
                    head = max(char_cap // 2, 256)
                    tail = max(char_cap - head, 128)
                    new_blocks.append(
                        f"{block[:head]}\n\n[... {omit} chars omitted after context overflow ...]\n\n{block[-tail:]}"
                    )
                    changed = True
                else:
                    new_blocks.append(block)
            if changed:
                new_content = new_blocks
        if changed:
            if result is None:
                result = list(messages)
            result[i] = msg.model_copy(update={"content": new_content})
    return result if result is not None else messages


def _truncate_messages_for_overflow(messages: list[BaseMessage], *, keep_tail: int = 8) -> tuple[list[BaseMessage], bool]:
    """Drop history and shrink payloads until something actually changes.

    Short threads with huge multimodal / tool payloads used to return
    ``changed=False`` (``len <= keep_tail+1``), which aborted overflow recovery.
    """
    from langchain_core.messages import SystemMessage

    from evoflow.agents.context_compaction_core import strip_image_base64_from_messages

    working = messages
    stripped = strip_image_base64_from_messages(working, strip_all=True)
    changed = stripped is not working
    working = stripped

    shrunk = _hard_shrink_message_contents(working)
    if shrunk is not working:
        working = shrunk
        changed = True

    if len(working) > keep_tail + 1:
        head = [m for m in working if isinstance(m, SystemMessage)]
        non_system_tail = [m for m in working if not isinstance(m, SystemMessage)][-keep_tail:]
        folded = head + non_system_tail
        if len(folded) < len(working):
            return folded, True

    if len(working) > 3:
        head = [m for m in working if isinstance(m, SystemMessage)]
        non_system = [m for m in working if not isinstance(m, SystemMessage)]
        folded = head + non_system[-2:]
        if len(folded) < len(working):
            return folded, True

    return working, changed


def _prepare_overflow_messages(messages: list[BaseMessage], _exc: Exception) -> list[BaseMessage]:
    """Strip vision payloads (and embedded data-URIs) before emergency fold/truncate.

    Always strip on overflow: Ark/DashScope often report ``image and text`` token
    limits, and leftover ``view_image`` base64 is a common silent culprit even
    when the error text is a generic context-length string.
    """
    try:
        from evoflow.agents.context_compaction_core import strip_image_base64_from_messages

        stripped = strip_image_base64_from_messages(messages, strip_all=True)
        return stripped if stripped is not messages else messages
    except Exception:
        return messages


def _log_model_error(exc: Exception, runtime: Runtime | None) -> None:
    tid = _runtime_thread_id(runtime)
    trace_id = _runtime_trace_id(runtime)
    trace_part = f" trace_id={trace_id}" if trace_id else ""
    thread_part = f" thread_id={tid}" if tid else ""

    logger.exception(
        "Model API request failed%s%s: %s: %s",
        thread_part,
        trace_part,
        exc.__class__.__name__,
        str(exc)[:500],
    )

    # Model errors are logged via logger.exception above; details live in observability SQLite when recorded elsewhere.


def _is_empty_ai_response(result: Any) -> bool:
    """Return True when the model returned an AIMessage with no content, tool_calls, or reasoning."""
    from evoflow.agents.middlewares.collab_cycle_trace_middleware import _ai_message_from_model_call_result
    from evoflow.persistence.chat_message_content import ai_message_has_visible_output

    ai = _ai_message_from_model_call_result(result)
    if ai is None:
        return False
    return not ai_message_has_visible_output(ai)


def _empty_response_user_fallback_message() -> str:
    return (
        "模型本轮未返回有效内容（无正文、无工具调用）。"
        "可能是提供商瞬时异常或上下文被压缩后失真；请重试或换一种表述。"
    )


def _thinking_truncated_user_notice() -> str:
    return (
        "模型输出 token 已用尽（finish_reason=length），思考链在未完成时被截断，"
        "未能生成正文或工具调用。建议：关闭 Thinking、缩短上下文，或换更大输出上限的模型。"
    )


def _normalize_finish_reason(raw: Any) -> str:
    text = str(raw or "").strip().lower()
    if not text:
        return ""
    half = len(text) // 2
    if half > 0 and text[:half] == text[half:]:
        return text[:half]
    return text


def _finish_reason_from_ai(ai: Any) -> str:
    rm = getattr(ai, "response_metadata", None)
    if isinstance(rm, dict):
        fr = _normalize_finish_reason(rm.get("finish_reason"))
        if fr:
            return fr
    ak = getattr(ai, "additional_kwargs", None)
    if isinstance(ak, dict):
        fr = _normalize_finish_reason(ak.get("finish_reason"))
        if fr:
            return fr
    return ""


def _looks_output_length_capped(ai: Any) -> bool:
    if "length" in _finish_reason_from_ai(ai):
        return True
    um = getattr(ai, "usage_metadata", None)
    if isinstance(um, dict):
        try:
            out_tok = int(um.get("output_tokens") or 0)
        except (TypeError, ValueError):
            out_tok = 0
        if out_tok >= 16384:
            return True
    return False


def _annotate_thinking_truncated_response(result: ModelCallResult, *, runtime: Runtime | None = None) -> ModelCallResult:
    """When thinking consumes the output budget, inject a visible user notice in ``content``."""
    from langchain.agents.middleware.types import ModelResponse
    from langchain_core.messages import AIMessage

    from evoflow.agents.middlewares.collab_cycle_trace_middleware import _ai_message_from_model_call_result
    from evoflow.persistence.chat_message_content import (
        _content_blocks_have_text,
        ai_message_has_reasoning,
    )

    ai = _ai_message_from_model_call_result(result)
    if ai is None or not isinstance(ai, AIMessage):
        return result
    if _content_blocks_have_text(getattr(ai, "content", None)):
        return result
    if getattr(ai, "tool_calls", None):
        return result
    if not ai_message_has_reasoning(ai):
        return result
    if not _looks_output_length_capped(ai):
        return result

    notice = _thinking_truncated_user_notice()
    logger.warning(
        "Model thinking truncated by output length (no visible content) thread=%s usage=%s",
        _runtime_thread_id(runtime),
        getattr(ai, "usage_metadata", None),
    )
    updated = ai.model_copy(update={"content": notice})
    if isinstance(result, ModelResponse):
        return ModelResponse(result=[updated])
    return updated


def _should_inject_empty_response_fallback(runtime: Runtime | None) -> bool:
    """Agent/idle sessions get a visible fallback; plan 协作阶段仍只记日志。"""
    if runtime is None:
        return True
    ctx = getattr(runtime, "context", None) or {}
    if not isinstance(ctx, dict):
        return True
    phase = str(ctx.get("collab_phase") or "").strip().lower()
    if phase in ("planning", "plan_ready", "awaiting_exec", "verifying", "reflecting"):
        return False
    return True


def _schedule_http_inject_evf(thread_id: str, payload: dict[str, Any]) -> None:
    """Best-effort inject on the detached poll loop (never the LangGraph job loop)."""

    async def _go() -> None:
        secret = (__import__("os").getenv("INTERNAL_EVENTS_SECRET") or "").strip()
        if not secret:
            return
        base = (__import__("os").getenv("EVOFLOW_GATEWAY_URL") or "http://127.0.0.1:8001").rstrip("/")
        url = f"{base}/api/events/internal/inject-evf"
        try:
            import httpx

            async with httpx.AsyncClient(timeout=3.0) as client:
                await client.post(
                    url,
                    json={"thread_id": thread_id, "payload": payload},
                    headers={"X-Internal-Events-Secret": secret},
                )
        except Exception:
            logger.debug("model fallback http inject failed thread=%s", thread_id, exc_info=True)

    try:
        from evoflow.subagents.detached_poll_scheduler import schedule_detached_poll

        schedule_detached_poll(_go(), name="model_fallback_inject")
    except Exception:
        logger.debug("model fallback inject schedule failed thread=%s", thread_id, exc_info=True)


def _inject_user_notice_evf(thread_id: str, body: str) -> bool:
    """Inject delta + error EVF frames into the live gateway SSE (middle layer / HTTP fallback)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    payloads = [
        {"type": "delta", "text": body, "delta_kind": "append"},
        {"type": "error", "error": body},
    ]
    injected = False
    try:
        from app.gateway.streaming.session_stream_inject import schedule_inject_evf_frame
        from app.gateway.streaming.stream_middle_layer import middle_layer_covers_thread

        if middle_layer_covers_thread(tid):
            for payload in payloads:
                schedule_inject_evf_frame(tid, payload)
            injected = True
    except Exception:
        logger.debug("model fallback direct inject failed thread=%s", tid, exc_info=True)
    if not injected:
        for payload in payloads:
            _schedule_http_inject_evf(tid, payload)
        injected = True
    return injected


def _emit_user_notice_stream(text: str, runtime: Runtime | None = None) -> bool:
    """Push user-visible notice to the live SSE lane (middleware AIMessage alone does not stream).

    Prefer gateway EVF inject when ``thread_id`` is known: after a mid-stream LLM
    failure (``chunk_count=0``), ``get_stream_writer`` custom events are often lost,
    and complete ``AIMessage`` rows are not replayed as live SSE. Writer is a
    best-effort extra channel only when inject is unavailable.
    """
    body = str(text or "").strip()
    if not body:
        return False
    tid = _runtime_thread_id(runtime)
    emitted = False
    if tid:
        emitted = _inject_user_notice_evf(tid, body)
    if not emitted:
        try:
            from langgraph.config import get_stream_writer

            writer = get_stream_writer()
            if writer:
                writer({"type": "empty_response_fallback", "text": body})
                emitted = True
        except Exception:
            logger.debug("empty fallback stream emit failed", exc_info=True)
    if not emitted:
        logger.warning(
            "empty fallback not streamed (no stream_writer/inject) thread=%s",
            tid,
        )
    try:
        from evoflow.observability.compaction_file_log import log_model_response_diagnosis

        log_model_response_diagnosis(
            "fallback流式推送",
            diagnosis="系统注入fallback文案（厂商重试后仍空）",
            thread_id=tid,
            fallback_injected=True,
            stream_emitted=emitted,
            content_len=len(body),
        )
    except Exception:
        pass
    return emitted


def _handle_empty_model_response(
    result: ModelCallResult,
    request: ModelRequest,
    *,
    empty_retry_attempt: int,
) -> ModelCallResult:
    if not _is_empty_ai_response(result):
        return result
    if empty_retry_attempt > 0 and _should_inject_empty_response_fallback(request.runtime):
        fallback_text = _empty_response_user_fallback_message()
        tid = _runtime_thread_id(request.runtime)
        logger.warning(
            "Model empty response after retry; injecting user-visible fallback thread=%s",
            tid,
        )
        _emit_user_notice_stream(fallback_text, request.runtime)
        try:
            from evoflow.observability.compaction_file_log import log_model_response_diagnosis

            fold_counts = None
            try:
                from evoflow.agents.middlewares.context_compaction_middleware import (
                    compaction_fold_msg_counts,
                )

                fold_counts = compaction_fold_msg_counts()
            except Exception:
                fold_counts = None
            extra: dict[str, Any] = {
                "fallback_injected": True,
                "empty_retry_attempt": empty_retry_attempt,
            }
            if fold_counts:
                extra["msgs_before_fold"] = fold_counts[0]
                extra["msgs_after_fold"] = fold_counts[1]
            log_model_response_diagnosis(
                "系统注入fallback",
                diagnosis="系统注入fallback（非厂商正文；UI应显示提示文案）",
                thread_id=tid,
                **extra,
            )
        except Exception:
            pass
        return AIMessage(content=fallback_text)
    return result


def _empty_retry_source_messages(request: ModelRequest) -> list[BaseMessage]:
    """Prefer the folded payload bound for the model over the outer checkpoint list."""
    try:
        from evoflow.agents.middlewares.context_compaction_middleware import last_bound_model_messages

        bound = last_bound_model_messages()
        if bound:
            return bound
    except Exception:
        pass
    raw = list((request.state or {}).get("messages") or []) if isinstance(request.state, dict) else []
    return [m for m in raw if isinstance(m, BaseMessage)]


def _prepare_empty_response_retry(request: ModelRequest) -> ModelRequest:
    from evoflow.agents.middlewares.context_compaction_middleware import mark_skip_compaction_once

    mark_skip_compaction_once()
    truncated, changed = _truncate_messages_for_overflow(_empty_retry_source_messages(request))
    return request.override(messages=truncated) if changed else request


class ModelFallbackMiddleware(AgentMiddleware[AgentState]):
    """Catch model-level exceptions and return a user-friendly AIMessage so the SSE stream doesn't abort."""

    state_schema = AgentState

    def _handle_model_error(self, exc: Exception, runtime: Runtime | None) -> AIMessage:
        _log_model_error(exc, runtime)
        if _should_reraise_for_supervisor(runtime):
            logger.error("Model API failed during supervisor orchestration; re-raising (thread=%s)", _runtime_thread_id(runtime))
            raise exc
        failed_name = _resolve_failed_model_name(exc, runtime)
        _mark_model_unavailable_for_error(failed_name, exc)
        message = _user_friendly_message_for_error(exc)
        if failed_name:
            reason = _retry_reason_label(classify(exc).reason)
            message = f"{message}（当前模型：{_model_display_name(failed_name)}，原因：{reason}）"
        _emit_user_notice_stream(message, runtime)
        return AIMessage(content=message)

    def _try_rate_limit_retry(
        self,
        request: ModelRequest,
        handler,
        exc: Exception,
        *,
        rate_limit_attempt: int = 0,
        compression_attempt: int = 0,
    ) -> ModelCallResult | None:
        if rate_limit_attempt >= _MAX_RATE_LIMIT_RETRIES:
            return None
        if classify(exc).reason != FailoverReason.RATE_LIMIT:
            return None
        next_attempt = rate_limit_attempt + 1
        wait_s = _calc_backoff_seconds(next_attempt, exc)
        logger.warning(
            "Model API rate limited, retrying attempt %d/%d after %.1fs (thread=%s)",
            next_attempt,
            _MAX_RATE_LIMIT_RETRIES,
            wait_s,
            _runtime_thread_id(request.runtime),
        )
        _emit_model_retry_activity(
            request.runtime,
            attempt=next_attempt,
            max_attempts=_MAX_RATE_LIMIT_RETRIES,
            reason=FailoverReason.RATE_LIMIT,
            wait_s=wait_s,
        )
        time.sleep(wait_s)
        return self.wrap_model_call(
            request,
            handler,
            compression_attempt=compression_attempt,
            rate_limit_attempt=next_attempt,
        )

    async def _try_rate_limit_retry_async(
        self,
        request: ModelRequest,
        handler,
        exc: Exception,
        *,
        rate_limit_attempt: int = 0,
        compression_attempt: int = 0,
    ) -> ModelCallResult | None:
        if rate_limit_attempt >= _MAX_RATE_LIMIT_RETRIES:
            return None
        if classify(exc).reason != FailoverReason.RATE_LIMIT:
            return None
        next_attempt = rate_limit_attempt + 1
        wait_s = _calc_backoff_seconds(next_attempt, exc)
        logger.warning(
            "Model API rate limited, retrying attempt %d/%d after %.1fs (thread=%s)",
            next_attempt,
            _MAX_RATE_LIMIT_RETRIES,
            wait_s,
            _runtime_thread_id(request.runtime),
        )
        _emit_model_retry_activity(
            request.runtime,
            attempt=next_attempt,
            max_attempts=_MAX_RATE_LIMIT_RETRIES,
            reason=FailoverReason.RATE_LIMIT,
            wait_s=wait_s,
        )
        await asyncio.sleep(wait_s)
        return await self.awrap_model_call(
            request,
            handler,
            compression_attempt=compression_attempt,
            rate_limit_attempt=next_attempt,
        )

    def _try_server_error_retry(
        self,
        request: ModelRequest,
        handler,
        exc: Exception,
        *,
        server_error_attempt: int = 0,
        compression_attempt: int = 0,
        rate_limit_attempt: int = 0,
    ) -> ModelCallResult | None:
        if server_error_attempt >= _MAX_SERVER_ERROR_RETRIES:
            return None
        reason = classify(exc).reason
        if reason not in _RETRYABLE_TRANSIENT_REASONS:
            return None
        next_attempt = server_error_attempt + 1
        wait_s = _calc_backoff_seconds(next_attempt, exc)
        logger.warning(
            "Model API %s, retrying attempt %d/%d after %.1fs (thread=%s)",
            reason.value,
            next_attempt,
            _MAX_SERVER_ERROR_RETRIES,
            wait_s,
            _runtime_thread_id(request.runtime),
        )
        _emit_model_retry_activity(
            request.runtime,
            attempt=next_attempt,
            max_attempts=_MAX_SERVER_ERROR_RETRIES,
            reason=reason,
            wait_s=wait_s,
        )
        time.sleep(wait_s)
        return self.wrap_model_call(
            request,
            handler,
            compression_attempt=compression_attempt,
            rate_limit_attempt=rate_limit_attempt,
            server_error_attempt=next_attempt,
        )

    async def _try_server_error_retry_async(
        self,
        request: ModelRequest,
        handler,
        exc: Exception,
        *,
        server_error_attempt: int = 0,
        compression_attempt: int = 0,
        rate_limit_attempt: int = 0,
    ) -> ModelCallResult | None:
        if server_error_attempt >= _MAX_SERVER_ERROR_RETRIES:
            return None
        reason = classify(exc).reason
        if reason not in _RETRYABLE_TRANSIENT_REASONS:
            return None
        next_attempt = server_error_attempt + 1
        wait_s = _calc_backoff_seconds(next_attempt, exc)
        logger.warning(
            "Model API %s, retrying attempt %d/%d after %.1fs (thread=%s)",
            reason.value,
            next_attempt,
            _MAX_SERVER_ERROR_RETRIES,
            wait_s,
            _runtime_thread_id(request.runtime),
        )
        _emit_model_retry_activity(
            request.runtime,
            attempt=next_attempt,
            max_attempts=_MAX_SERVER_ERROR_RETRIES,
            reason=reason,
            wait_s=wait_s,
        )
        await asyncio.sleep(wait_s)
        return await self.awrap_model_call(
            request,
            handler,
            compression_attempt=compression_attempt,
            rate_limit_attempt=rate_limit_attempt,
            server_error_attempt=next_attempt,
        )

    def _messages_from_request(self, request: ModelRequest) -> list[BaseMessage]:
        # Prefer the payload actually bound for this model call (may already be
        # folded / image-injected) over the full checkpoint transcript in state.
        raw: list[Any] = []
        req_msgs = getattr(request, "messages", None)
        if req_msgs:
            raw = list(req_msgs)
        elif isinstance(request.state, dict):
            raw = list(request.state.get("messages") or [])
        return [m for m in raw if isinstance(m, BaseMessage)]

    def _retry_after_overflow(
        self,
        request: ModelRequest,
        handler,
        compressed: list[BaseMessage],
        *,
        compression_attempt: int,
        sync: bool,
    ):
        next_attempt = compression_attempt + 1
        logger.info(
            "Emergency context compression succeeded (attempt=%d); retrying model call",
            next_attempt,
        )
        _emit_model_retry_activity(
            request.runtime,
            attempt=next_attempt,
            max_attempts=2,
            reason=FailoverReason.CONTEXT_OVERFLOW,
            note="已紧急压缩上下文",
        )
        try:
            from evoflow.observability.compaction_file_log import log_compaction_trace

            log_compaction_trace(
                "紧急压缩成功",
                thread_id=_runtime_thread_id(request.runtime),
                compression_attempt=next_attempt,
                note="retrying_model_call",
            )
        except Exception:
            pass
        try:
            # Send the already-stripped/folded payload; do not re-expand via fold.
            from evoflow.agents.middlewares.context_compaction_middleware import mark_skip_compaction_once

            mark_skip_compaction_once()
        except Exception:
            pass
        overridden = request.override(messages=compressed)
        if sync:
            return self.wrap_model_call(
                overridden,
                handler,
                compression_attempt=next_attempt,
            )
        return self.awrap_model_call(
            overridden,
            handler,
            compression_attempt=next_attempt,
        )

    def _try_overflow_compress_and_retry(
        self,
        request: ModelRequest,
        handler,
        exc: Exception,
        *,
        compression_attempt: int = 0,
    ) -> ModelCallResult | None:
        if compression_attempt >= 2:
            return None
        if not classify(exc).should_compress:
            return None
        messages = self._messages_from_request(request)
        if not messages:
            return None
        original_messages = messages
        messages = _prepare_overflow_messages(messages, exc)
        try:
            if compression_attempt == 0 and len(messages) >= 2:
                from evoflow.agents.middlewares.context_compaction_middleware import emergency_compress_messages

                compressed, changed = emergency_compress_messages(messages, request.runtime)
                if not changed and messages is not original_messages:
                    compressed, changed = messages, True
            else:
                compressed, changed = _truncate_messages_for_overflow(messages)
                if not changed and messages is not original_messages:
                    compressed, changed = messages, True
        except Exception as compress_exc:
            logger.warning("Emergency context compression failed: %s", compress_exc)
            try:
                from evoflow.observability.compaction_file_log import log_compaction_trace

                log_compaction_trace(
                    "紧急压缩失败",
                    level=logging.WARNING,
                    compression_attempt=compression_attempt,
                    error=str(compress_exc),
                )
            except Exception:
                pass
            return None
        if not changed:
            if compression_attempt == 0:
                return self._try_overflow_compress_and_retry(
                    request,
                    handler,
                    exc,
                    compression_attempt=1,
                )
            return None
        return self._retry_after_overflow(
            request,
            handler,
            compressed,
            compression_attempt=compression_attempt,
            sync=True,
        )

    async def _try_overflow_compress_and_retry_async(
        self,
        request: ModelRequest,
        handler,
        exc: Exception,
        *,
        compression_attempt: int = 0,
    ) -> ModelCallResult | None:
        if compression_attempt >= 2:
            return None
        if not classify(exc).should_compress:
            return None
        messages = self._messages_from_request(request)
        if not messages:
            return None
        original_messages = messages
        messages = _prepare_overflow_messages(messages, exc)
        try:
            if compression_attempt == 0 and len(messages) >= 2:
                from evoflow.agents.middlewares.context_compaction_middleware import (
                    emergency_compress_messages_async,
                )

                compressed, changed = await emergency_compress_messages_async(messages, request.runtime)
                if not changed and messages is not original_messages:
                    compressed, changed = messages, True
            else:
                compressed, changed = _truncate_messages_for_overflow(messages)
                if not changed and messages is not original_messages:
                    compressed, changed = messages, True
        except Exception as compress_exc:
            logger.warning("Emergency context compression failed: %s", compress_exc)
            try:
                from evoflow.observability.compaction_file_log import log_compaction_trace

                log_compaction_trace(
                    "紧急压缩失败",
                    level=logging.WARNING,
                    compression_attempt=compression_attempt,
                    error=str(compress_exc),
                )
            except Exception:
                pass
            return None
        if not changed:
            if compression_attempt == 0:
                return await self._try_overflow_compress_and_retry_async(
                    request,
                    handler,
                    exc,
                    compression_attempt=1,
                )
            return None
        return await self._retry_after_overflow(
            request,
            handler,
            compressed,
            compression_attempt=compression_attempt,
            sync=False,
        )

    def _try_credential_rotation_or_fallback(
        self,
        request: ModelRequest,
        handler,
        exc: Exception,
        *,
        credential_attempt: int = 0,
        fallback_attempt: int = 0,
        compression_attempt: int = 0,
        rate_limit_attempt: int = 0,
    ) -> ModelCallResult | None:
        """Try credential rotation and/or model fallback for auth/provider errors."""
        classification = classify(exc)
        can_rotate = classification.should_rotate_credential and credential_attempt < _MAX_CREDENTIAL_ROTATIONS
        can_fallback = (
            classification.should_fallback_provider or classification.should_rotate_credential
        ) and fallback_attempt < _MAX_MODEL_FALLBACKS

        if not can_rotate and not can_fallback:
            return None

        model = _extract_model_instance(exc)

        # ── Step 1: Credential rotation ──────────────────────────────────
        if can_rotate and model is not None:
            pool = getattr(model, "_credential_pool", None)
            if pool is not None:
                fail_reason = classification.reason.value
                next_cred = pool.rotate(fail_reason)
                if next_cred is not None:
                    from evoflow.models.credential_sanitize import apply_credential_to_model

                    apply_credential_to_model(model, next_cred.api_key, next_cred.base_url)
                    logger.warning(
                        "Model API error (%s), rotating credential attempt %d/%d (thread=%s, cred=%s)",
                        fail_reason,
                        credential_attempt + 1,
                        _MAX_CREDENTIAL_ROTATIONS,
                        _runtime_thread_id(request.runtime),
                        next_cred.short_id(),
                    )
                    return self.wrap_model_call(
                        request,
                        handler,
                        compression_attempt=compression_attempt,
                        rate_limit_attempt=rate_limit_attempt,
                        credential_attempt=credential_attempt + 1,
                        fallback_attempt=fallback_attempt,
                    )

        # ── Step 2: Model fallback ───────────────────────────────────────
        if can_fallback and model is not None:
            fallback_models: list[str] = list(getattr(model, "_evoflow_fallback_models", None) or [])
            primary_name = getattr(model, "_evoflow_primary_model_name", "") or ""
            if not primary_name:
                primary_name = _resolve_failed_model_name(exc, request.runtime)
            raw_candidates = [m for m in fallback_models if m != primary_name]
            candidates = _filter_available_fallback_candidates(raw_candidates)
            # Primary is exhausted for this recovery path — mark unavailable before trying fallbacks.
            if candidates:
                _mark_model_unavailable_for_error(primary_name, exc)
            for i in range(fallback_attempt, min(fallback_attempt + _MAX_MODEL_FALLBACKS, len(candidates))):
                fb_name = candidates[i]
                logger.warning(
                    "Model API failed, falling back to model %r attempt %d/%d (thread=%s)",
                    fb_name,
                    i + 1,
                    _MAX_MODEL_FALLBACKS,
                    _runtime_thread_id(request.runtime),
                )
                try:
                    from evoflow.models.factory import create_chat_model

                    fb_model = create_chat_model(fb_name)
                    messages = self._messages_from_request(request)
                    fb_result = fb_model.invoke(messages)
                    logger.info(
                        "Fallback model %r succeeded (thread=%s)",
                        fb_name,
                        _runtime_thread_id(request.runtime),
                    )
                    _on_fallback_model_succeeded(
                        request.runtime,
                        primary_name=primary_name,
                        fallback_name=fb_name,
                        primary_exc=exc,
                    )
                    return fb_result  # type: ignore[return-value]
                except Exception as fb_exc:
                    logger.warning(
                        "Fallback model %r also failed: %s: %s",
                        fb_name,
                        type(fb_exc).__name__,
                        str(fb_exc)[:300],
                    )
                    _mark_model_unavailable_for_error(fb_name, fb_exc)
                    continue

        return None

    async def _try_credential_rotation_or_fallback_async(
        self,
        request: ModelRequest,
        handler,
        exc: Exception,
        *,
        credential_attempt: int = 0,
        fallback_attempt: int = 0,
        compression_attempt: int = 0,
        rate_limit_attempt: int = 0,
    ) -> ModelCallResult | None:
        """Try credential rotation and/or model fallback for auth/provider errors (async)."""
        classification = classify(exc)
        can_rotate = classification.should_rotate_credential and credential_attempt < _MAX_CREDENTIAL_ROTATIONS
        can_fallback = (
            classification.should_fallback_provider or classification.should_rotate_credential
        ) and fallback_attempt < _MAX_MODEL_FALLBACKS

        if not can_rotate and not can_fallback:
            return None

        model = _extract_model_instance(exc)

        # ── Step 1: Credential rotation ──────────────────────────────────
        if can_rotate and model is not None:
            pool = getattr(model, "_credential_pool", None)
            if pool is not None:
                fail_reason = classification.reason.value
                next_cred = pool.rotate(fail_reason)
                if next_cred is not None:
                    from evoflow.models.credential_sanitize import apply_credential_to_model

                    apply_credential_to_model(model, next_cred.api_key, next_cred.base_url)
                    logger.warning(
                        "Model API error (%s), rotating credential attempt %d/%d (thread=%s, cred=%s)",
                        fail_reason,
                        credential_attempt + 1,
                        _MAX_CREDENTIAL_ROTATIONS,
                        _runtime_thread_id(request.runtime),
                        next_cred.short_id(),
                    )
                    return await self.awrap_model_call(
                        request,
                        handler,
                        compression_attempt=compression_attempt,
                        rate_limit_attempt=rate_limit_attempt,
                        credential_attempt=credential_attempt + 1,
                        fallback_attempt=fallback_attempt,
                    )

        # ── Step 2: Model fallback ───────────────────────────────────────
        if can_fallback and model is not None:
            fallback_models: list[str] = list(getattr(model, "_evoflow_fallback_models", None) or [])
            primary_name = getattr(model, "_evoflow_primary_model_name", "") or ""
            if not primary_name:
                primary_name = _resolve_failed_model_name(exc, request.runtime)
            raw_candidates = [m for m in fallback_models if m != primary_name]
            candidates = _filter_available_fallback_candidates(raw_candidates)
            if candidates:
                _mark_model_unavailable_for_error(primary_name, exc)
            for i in range(fallback_attempt, min(fallback_attempt + _MAX_MODEL_FALLBACKS, len(candidates))):
                fb_name = candidates[i]
                logger.warning(
                    "Model API failed, falling back to model %r attempt %d/%d (thread=%s)",
                    fb_name,
                    i + 1,
                    _MAX_MODEL_FALLBACKS,
                    _runtime_thread_id(request.runtime),
                )
                try:
                    from evoflow.models.factory import create_chat_model

                    fb_model = create_chat_model(fb_name)
                    messages = self._messages_from_request(request)
                    fb_result = await fb_model.ainvoke(messages)
                    logger.info(
                        "Fallback model %r succeeded (thread=%s)",
                        fb_name,
                        _runtime_thread_id(request.runtime),
                    )
                    _on_fallback_model_succeeded(
                        request.runtime,
                        primary_name=primary_name,
                        fallback_name=fb_name,
                        primary_exc=exc,
                    )
                    return fb_result  # type: ignore[return-value]
                except Exception as fb_exc:
                    logger.warning(
                        "Fallback model %r also failed: %s: %s",
                        fb_name,
                        type(fb_exc).__name__,
                        str(fb_exc)[:300],
                    )
                    _mark_model_unavailable_for_error(fb_name, fb_exc)
                    continue

        return None

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler,
        *,
        compression_attempt: int = 0,
        rate_limit_attempt: int = 0,
        empty_retry_attempt: int = 0,
        credential_attempt: int = 0,
        fallback_attempt: int = 0,
        server_error_attempt: int = 0,
    ) -> ModelCallResult:
        try:
            result = handler(request)
        except GraphBubbleUp:
            raise
        except Exception as exc:
            if not _is_model_api_error(exc):
                raise
            retry_result = self._try_overflow_compress_and_retry(
                request,
                handler,
                exc,
                compression_attempt=compression_attempt,
            )
            if retry_result is not None:
                return retry_result
            retry_result = self._try_rate_limit_retry(
                request,
                handler,
                exc,
                rate_limit_attempt=rate_limit_attempt,
                compression_attempt=compression_attempt,
            )
            if retry_result is not None:
                return retry_result
            retry_result = self._try_server_error_retry(
                request,
                handler,
                exc,
                server_error_attempt=server_error_attempt,
                compression_attempt=compression_attempt,
                rate_limit_attempt=rate_limit_attempt,
            )
            if retry_result is not None:
                return retry_result
            retry_result = self._try_credential_rotation_or_fallback(
                request,
                handler,
                exc,
                credential_attempt=credential_attempt,
                fallback_attempt=fallback_attempt,
                compression_attempt=compression_attempt,
                rate_limit_attempt=rate_limit_attempt,
            )
            if retry_result is not None:
                return retry_result
            return self._handle_model_error(exc, request.runtime)

        # Live call succeeded — clear any stale unavailable mark for this session model.
        _clear_model_unavailable_quiet(_resolve_model_name(request.runtime) or "")

        if _is_empty_ai_response(result):
            self._log_empty_response(result, request, empty_retry_attempt=empty_retry_attempt)
            if empty_retry_attempt == 0:
                retry_request = _prepare_empty_response_retry(request)
                logger.warning(
                    "Model returned empty response; retrying once with truncated context thread=%s changed=%s",
                    _runtime_thread_id(request.runtime),
                    retry_request is not request,
                )
                retry = handler(retry_request)
                if not _is_empty_ai_response(retry):
                    return retry
                return _handle_empty_model_response(retry, request, empty_retry_attempt=1)
            return _handle_empty_model_response(result, request, empty_retry_attempt=empty_retry_attempt)

        return _annotate_thinking_truncated_response(result, runtime=request.runtime)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler,
        *,
        compression_attempt: int = 0,
        rate_limit_attempt: int = 0,
        empty_retry_attempt: int = 0,
        credential_attempt: int = 0,
        fallback_attempt: int = 0,
        server_error_attempt: int = 0,
    ) -> ModelCallResult:
        try:
            result = await handler(request)
        except GraphBubbleUp:
            raise
        except Exception as exc:
            if not _is_model_api_error(exc):
                raise
            retry_result = await self._try_overflow_compress_and_retry_async(
                request,
                handler,
                exc,
                compression_attempt=compression_attempt,
            )
            if retry_result is not None:
                return retry_result
            retry_result = await self._try_rate_limit_retry_async(
                request,
                handler,
                exc,
                rate_limit_attempt=rate_limit_attempt,
                compression_attempt=compression_attempt,
            )
            if retry_result is not None:
                return retry_result
            retry_result = await self._try_server_error_retry_async(
                request,
                handler,
                exc,
                server_error_attempt=server_error_attempt,
                compression_attempt=compression_attempt,
                rate_limit_attempt=rate_limit_attempt,
            )
            if retry_result is not None:
                return retry_result
            retry_result = await self._try_credential_rotation_or_fallback_async(
                request,
                handler,
                exc,
                credential_attempt=credential_attempt,
                fallback_attempt=fallback_attempt,
                compression_attempt=compression_attempt,
                rate_limit_attempt=rate_limit_attempt,
            )
            if retry_result is not None:
                return retry_result
            return self._handle_model_error(exc, request.runtime)

        _clear_model_unavailable_quiet(_resolve_model_name(request.runtime) or "")

        if _is_empty_ai_response(result):
            self._log_empty_response(
                result,
                request,
                empty_retry_attempt=empty_retry_attempt,
                compaction_skipped=empty_retry_attempt > 0,
            )
            if empty_retry_attempt == 0:
                retry_request = _prepare_empty_response_retry(request)
                logger.warning(
                    "Model returned empty response; retrying once with truncated context thread=%s changed=%s",
                    _runtime_thread_id(request.runtime),
                    retry_request is not request,
                )
                retry = await handler(retry_request)
                if not _is_empty_ai_response(retry):
                    return retry
                return _handle_empty_model_response(retry, request, empty_retry_attempt=1)
            return _handle_empty_model_response(result, request, empty_retry_attempt=empty_retry_attempt)

        return _annotate_thinking_truncated_response(result, runtime=request.runtime)

    def _log_empty_response(
        self,
        result: ModelCallResult,
        request: ModelRequest,
        *,
        empty_retry_attempt: int = 0,
        compaction_skipped: bool = False,
    ) -> None:
        """Log detailed info when model returns empty response for debugging."""
        from evoflow.agents.middlewares.collab_cycle_trace_middleware import _ai_message_from_model_call_result

        ai = _ai_message_from_model_call_result(result)
        tid = _runtime_thread_id(request.runtime)
        trace_id = _runtime_trace_id(request.runtime)
        usage = getattr(ai, "usage_metadata", None) if ai is not None else None
        resp_meta = getattr(ai, "response_metadata", None) if ai is not None else None
        logger.warning(
            "Model returned empty response (content='', no tool_calls) thread=%s trace_id=%s usage=%s response_metadata=%s",
            tid,
            trace_id,
            usage,
            resp_meta,
        )
        try:
            from evoflow.agents.context_compaction_core import compaction_token_snapshot
            from evoflow.agents.middlewares.context_compaction_middleware import (
                compaction_fold_msg_counts,
                compaction_folded_this_call,
            )
            from evoflow.observability.compaction_file_log import (
                count_message_rounds,
                log_model_response_diagnosis,
                usage_fields_from_ai,
            )
            from evoflow.utils.model_context_length import resolve_model_context_length

            messages = self._messages_from_request(request)
            model_name = _resolve_model_name(request.runtime)
            ctx_len = resolve_model_context_length(model_name)
            snap = compaction_token_snapshot(messages, context_length=ctx_len) if messages else {}
            folded = compaction_folded_this_call()
            fold_counts = compaction_fold_msg_counts()
            if compaction_skipped:
                diagnosis = "跳过压缩后厂商仍空返回（API output=0）"
            elif folded:
                diagnosis = "压缩后厂商空返回（API output=0，非系统剥工具）"
            elif empty_retry_attempt > 0:
                diagnosis = "厂商空返回（重试轮次，API output=0）"
            else:
                diagnosis = "厂商空返回（API output=0，finish_reason=stop）"
            extra: dict[str, Any] = {
                **usage_fields_from_ai(ai),
                "trace_id": trace_id,
                "context_length": ctx_len,
                "model_context": f"{ctx_len // 1000}k",
                "gate_tokens": snap.get("gate_tokens"),
                "pct_of_context": snap.get("pct_of_context"),
                "usage": usage,
                "response_metadata": resp_meta,
                "empty_retry_attempt": empty_retry_attempt,
                "compaction_folded": folded,
                "compaction_skipped": compaction_skipped,
                **(count_message_rounds(messages) if messages else {}),
            }
            if fold_counts:
                extra["msgs_before_fold"] = fold_counts[0]
                extra["msgs_after_fold"] = fold_counts[1]
            log_model_response_diagnosis(
                "模型空返回",
                diagnosis=diagnosis,
                thread_id=tid,
                model_name=model_name,
                level=logging.WARNING,
                **extra,
            )
        except Exception:
            logger.debug("compaction trace log failed (empty response)", exc_info=True)
