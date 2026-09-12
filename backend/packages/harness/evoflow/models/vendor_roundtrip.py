"""Full vendor request + model response persistence (SQLite observability).

``create_chat_model`` only constructs provider classes; HTTP is invoked inside LangChain / SDK
implementations. This module pairs the payload captured in ``log_model_request_payload`` with the
``ChatResult`` (or error) observed after ``_generate`` / ``_agenerate`` / ``_stream`` / ``_astream``.
"""

from __future__ import annotations

import asyncio
import contextvars
import copy
import inspect
import json
import logging
import os
import time
from typing import Any

from langchain_core.messages import message_to_dict
from langchain_core.outputs import ChatGenerationChunk, ChatResult

from evoflow.timeutil import instant_to_beijing_iso


def _attach_model_to_exception(exc: BaseException, model: Any) -> None:
    """Attach the chat model instance to *exc* so middleware can access it for credential rotation."""
    try:
        setattr(exc, "_evoflow_model", model)
    except Exception:
        pass

logger = logging.getLogger(__name__)

_STACK: contextvars.ContextVar[list[dict[str, Any]]] = contextvars.ContextVar(
    "evoflow_vendor_roundtrip_stack",
    default=[],
)


def _env_bool(name: str, default: bool) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    return default


def roundtrip_enabled() -> bool:
    """Master switch for registering pushes and flushing roundtrip logs."""
    return _env_bool("EVOFLOW_MODEL_VENDOR_ROUNDTRIP", True)


def _stream_retry_attempts() -> int:
    raw = (os.environ.get("EVOFLOW_STREAM_RETRY_ATTEMPTS") or "2").strip()
    try:
        return max(1, min(5, int(raw)))
    except ValueError:
        return 2


def _stream_retry_backoff_seconds(attempt: int) -> float:
    return min(2.0 * (2 ** max(0, attempt)), 8.0)


def _is_retriable_stream_error(exc: BaseException) -> bool:
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
        return True
    name = type(exc).__name__
    if name in {
        "TimeoutError",
        "APITimeoutError",
        "ReadTimeout",
        "ConnectTimeout",
        "ConnectTimeoutError",
    }:
        return True
    msg = str(exc).lower()
    if "timeout" in msg or "timed out" in msg:
        return True
    if "429" in msg or "rate limit" in msg:
        return True
    return False


def _max_roundtrip_json_chars() -> int:
    raw = (os.environ.get("EVOFLOW_MODEL_ROUNDTRIP_MAX_JSON_CHARS") or "").strip()
    if not raw:
        return 10_485_760  # 10 MiB per stored JSON field (request / response)
    try:
        return max(65_536, int(raw))
    except ValueError:
        return 10_485_760


def _redact_secrets(obj: Any) -> Any:
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            lk = str(k).lower()
            if lk in {"authorization", "api_key", "x-api-key", "token", "access_token"}:
                out[k] = "<redacted>"
            else:
                out[k] = _redact_secrets(v)
        return out
    if isinstance(obj, list):
        return [_redact_secrets(x) for x in obj]
    return obj


def push_vendor_request(
    *,
    provider: str,
    model: str | None,
    payload: dict[str, Any],
    invocation_kind: str | None = None,
    pending_row_id: str | None = None,
    phase1_record: dict[str, Any] | None = None,
) -> None:
    """Push a request entry onto the contextvar stack.

    Always pushes (even when roundtrip logging is disabled) so that
    :func:`complete_vendor_roundtrip` can find ``pending_row_id`` to UPDATE.
    The expensive ``deepcopy`` + ``_redact_secrets`` of *payload* is skipped
    when roundtrip is disabled.
    """
    try:
        rt = roundtrip_enabled()
        entry = {
            "provider": provider,
            "model": model,
            "payload": _redact_secrets(copy.deepcopy(payload)) if rt else None,
            "pushed_at_ms": int(time.time() * 1000),
            "invocation_kind": (invocation_kind or "").strip() or None,
            "pending_row_id": pending_row_id,
            "phase1_record": copy.deepcopy(phase1_record) if isinstance(phase1_record, dict) else None,
        }
        stack = list(_STACK.get())
        stack.append(entry)
        _STACK.set(stack)
    except Exception:
        logger.debug("vendor_roundtrip push failed", exc_info=True)


def _pop_vendor_request() -> dict[str, Any] | None:
    try:
        stack = list(_STACK.get())
        if not stack:
            return None
        entry = stack.pop()
        _STACK.set(stack)
        return entry
    except Exception:
        return None


def _cap_json_str(s: str) -> str:
    raw = (os.environ.get("EVOFLOW_MODEL_ROUNDTRIP_MAX_JSON_CHARS") or "").strip().lower()
    if raw in ("0", "unlimited", "none", "off"):
        return s
    cap = _max_roundtrip_json_chars()
    if len(s) <= cap:
        return s
    return f"{s[:cap]}\n...<truncated total_chars={len(s)}>"


def prepare_vendor_request_for_observability(payload: dict[str, Any]) -> dict[str, Any]:
    """Full vendor HTTP body for observability storage (secrets redacted only)."""
    return _redact_secrets(copy.deepcopy(payload))


_OBS_USER_PREVIEW_MAX_CHARS = 8000


def build_observability_request_record(vendor_payload: dict[str, Any]) -> dict[str, Any]:
    """Compact record for SQLite: prompts/users first; tool names without full schemas.

    Vendor bodies often place a huge ``tools`` array *before* ``messages``, so naive
    truncation at 32KB drops system prompt and user turns. This layout survives caps.

    ``messages`` is stored in full (no tail clip) so Obs message_count matches the
    real vendor request; only tool *schemas* are replaced by names to save space.
    """
    from evoflow.models.request_payload_logger import (
        extract_latest_user_preview_from_vendor_payload,
        extract_system_prompt_full_from_vendor_payload,
        text_content_stats,
        tool_names_from_vendor_payload,
        tool_stats_from_vendor_payload,
    )

    model_hint = str(vendor_payload.get("model") or "").strip() or None
    vendor = prepare_vendor_request_for_observability(vendor_payload)
    record: dict[str, Any] = {}

    # Token stats are best-effort. When tiktoken is still warming, skip expensive
    # per-tool encode passes so observability never amplifies a cold-start stall.
    token_stats_ok = True
    try:
        from evoflow.context.compaction_token_utils import token_encodings_ready

        token_stats_ok = bool(token_encodings_ready())
    except Exception:
        token_stats_ok = False

    full_sp = extract_system_prompt_full_from_vendor_payload(vendor)
    if full_sp:
        # Do not duplicate system text: full prompt lives in ``messages`` / instructions.
        if token_stats_ok:
            record["system_prompt_stats"] = text_content_stats(full_sp, model=model_hint)
        else:
            record["system_prompt_stats"] = {"chars": len(full_sp), "tokens": -1}

    latest = extract_latest_user_preview_from_vendor_payload(vendor)
    if latest:
        if token_stats_ok:
            record["latest_user_stats"] = text_content_stats(latest, model=model_hint)
        else:
            record["latest_user_stats"] = {"chars": len(latest), "tokens": -1}
        if len(latest) > _OBS_USER_PREVIEW_MAX_CHARS:
            record["latest_user_preview"] = (
                latest[:_OBS_USER_PREVIEW_MAX_CHARS] + f"...<truncated:{len(latest)}>"
            )
        else:
            record["latest_user_preview"] = latest

    tool_names = tool_names_from_vendor_payload(vendor)
    if token_stats_ok:
        tool_stats = tool_stats_from_vendor_payload(vendor_payload, model=model_hint)
        if tool_stats:
            record["request_tools_stats"] = tool_stats
            record["request_tools_tokens_total"] = sum(
                int(row.get("tokens") or 0) for row in tool_stats
            )
    if tool_names:
        record["request_tool_names"] = tool_names

    for key in ("model", "stream", "extra_body", "max_completion_tokens", "temperature"):
        val = vendor.get(key)
        if val is not None:
            record[key] = val
    if vendor.get("instructions") is not None:
        record["instructions"] = vendor.get("instructions")
    if vendor.get("system") is not None:
        record["system"] = vendor.get("system")

    messages = vendor.get("messages")
    if isinstance(messages, list) and messages:
        # Keep the full transcript — do not tail-clip for Obs (was _OBS_MESSAGES_TAIL_MAX=40).
        record["messages"] = messages
        record["message_count"] = len(messages)

    if tool_names:
        record["tools"] = [{"type": "function", "function": {"name": n}} for n in tool_names]

    return record


def build_observability_response_record(response_body: dict[str, Any]) -> dict[str, Any]:
    """Add top-level assistant preview so truncated response JSON still shows reply text."""
    from evoflow.observability.queries import _response_summary_from_json

    out = copy.deepcopy(response_body)
    summary = _response_summary_from_json(out)
    if isinstance(summary, dict):
        preview = str(summary.get("contentPreview") or "").strip()
        if preview:
            out["assistant_preview"] = preview
            from evoflow.models.request_payload_logger import text_content_stats

            out["assistant_stats"] = text_content_stats(preview)
        tool_names = summary.get("toolNames")
        if isinstance(tool_names, list) and tool_names:
            out["response_tool_names"] = tool_names
    return out


def serialize_vendor_request_json(payload: dict[str, Any] | None) -> str | None:
    """JSON-encode vendor request for SQLite ``request_json`` (UI-oriented layout).

    Always keeps a valid JSON object with accurate ``message_count``. When the full
    transcript exceeds the observability storage budget, shrink ``messages`` (tail
    only) rather than mid-string truncating — mid-cut JSON made list parsing fail
    and the UI showed 「—」 for message count.
    """
    if payload is None:
        return None
    record = build_observability_request_record(payload)
    return _serialize_obs_request_record(record)


def _obs_stored_json_budget() -> int:
    """Match sqlite_store ``_STORED_MODEL_JSON_LIMIT`` (512 KiB) with a small margin."""
    raw = (os.environ.get("EVOFLOW_OBS_REQUEST_JSON_BUDGET") or "").strip()
    if raw:
        try:
            return max(8_192, int(raw))
        except ValueError:
            pass
    return 500_000  # under 512 KiB store cap


def _is_system_role_message(msg: Any) -> bool:
    if not isinstance(msg, dict):
        return False
    role = str(msg.get("role") or "").strip().lower()
    if role in {"system", "developer"}:
        return True
    typ = str(msg.get("type") or "").strip().lower()
    return typ in {"system", "systemmessage"}


def _tail_messages_preserve_system(messages: list[Any], keep: int) -> list[Any]:
    """Keep all system/developer messages plus the tail of the rest.

    The vendor payload usually puts the system prompt in the first message(s);
    tail-only shrinking would drop it and make the「系统提示词」tab lose content.
    """
    if not messages:
        return []
    system_msgs = [m for m in messages if _is_system_role_message(m)]
    other_msgs = [m for m in messages if not _is_system_role_message(m)]
    if keep <= 0:
        # System prompt must never be dropped just because the tail budget hit 0.
        return system_msgs
    if keep >= len(other_msgs):
        return system_msgs + other_msgs
    return system_msgs + other_msgs[-keep:]


def _serialize_obs_request_record(record: dict[str, Any]) -> str:
    """Dump record to JSON; if over budget, keep message_count and shrink messages."""
    budget = _obs_stored_json_budget()
    msgs = record.get("messages")
    full_n = 0
    if isinstance(msgs, list):
        full_n = len(msgs)
        if record.get("message_count") is None:
            record["message_count"] = full_n
    else:
        try:
            full_n = int(record.get("message_count") or 0)
        except (TypeError, ValueError):
            full_n = 0

    def _dump(obj: dict[str, Any]) -> str:
        # Put count/meta first so even mid-string truncation leaves them parseable.
        ordered: dict[str, Any] = {}
        for key in ("message_count", "messages_truncated", "model", "stream", "temperature"):
            if key in obj:
                ordered[key] = obj[key]
        for key, val in obj.items():
            if key not in ordered:
                ordered[key] = val
        return json.dumps(ordered, ensure_ascii=False, default=str)

    raw = _dump(record)
    if len(raw) <= budget:
        return _cap_json_str(raw)

    # Prefer accurate count over storing every message body in Obs SQLite.
    if isinstance(msgs, list) and msgs:
        for keep in (40, 20, 10, 5, 2, 1, 0):
            slim = dict(record)
            slim["message_count"] = full_n
            slim["messages"] = _tail_messages_preserve_system(msgs, keep)
            slim["messages_truncated"] = f"stored_tail_{keep}_of_{full_n}"
            raw = _dump(slim)
            if len(raw) <= budget:
                return raw

    # Last resort: metadata only (still valid JSON with message_count).
    meta = {k: v for k, v in record.items() if k != "messages"}
    meta["message_count"] = full_n
    meta["messages"] = []
    meta["messages_truncated"] = f"omitted_all_of_{full_n}"
    raw = _dump(meta)
    if len(raw) <= budget:
        return raw
    return _cap_json_str(raw)


def _ensure_chat_result(value: Any) -> ChatResult:
    """Normalize sync ``_generate`` output; reject un-awaited coroutines on a running loop."""
    if not inspect.iscoroutine(value):
        return value
    try:
        asyncio.get_running_loop()
        has_loop = True
    except RuntimeError:
        has_loop = False
    if not has_loop:
        return asyncio.run(value)
    raise TypeError(
        "Chat model _generate returned an unawaited coroutine; use ainvoke() in async contexts."
    )


def _first_chat_generation(chat_result: ChatResult) -> Any:
    gens = chat_result.generations or []
    if not gens:
        return None
    head = gens[0]
    if isinstance(head, list):
        return head[0] if head else None
    return head


def _usage_blob_for_sqlite(chat_result: ChatResult) -> dict[str, Any] | None:
    """Build a JSON-serializable usage payload when ``llm_output`` is empty (common for streams).

    LangChain often attaches token counts to ``AIMessage.usage_metadata`` while leaving
    ``ChatResult.llm_output`` as ``{}``. We persist both shapes so observability can aggregate tokens.
    """
    parts: dict[str, Any] = {}
    lo = chat_result.llm_output
    if isinstance(lo, dict) and lo:
        parts["llm_output"] = lo
    gen = _first_chat_generation(chat_result)
    if gen is not None:
        msg = getattr(gen, "message", None)
        if msg is not None:
            um = getattr(msg, "usage_metadata", None)
            if isinstance(um, dict) and um:
                parts["usage_metadata"] = um
            rm = getattr(msg, "response_metadata", None)
            if isinstance(rm, dict):
                nested: dict[str, Any] = {}
                for key in ("usage", "token_usage"):
                    v = rm.get(key)
                    if isinstance(v, dict) and v:
                        nested[key] = v
                if nested:
                    parts["response_metadata_subset"] = nested
    return parts or None


def _serialize_chat_result(res: ChatResult) -> dict[str, Any]:
    """Serialize ``ChatResult.generations`` (flat ``list[ChatGeneration]`` or legacy list-of-lists)."""
    if inspect.iscoroutine(res):
        raise TypeError(
            "Chat model returned an unawaited coroutine; use ainvoke() in async contexts."
        )
    generations_out: list[list[dict[str, Any]]] = []
    gens = list(res.generations or [])
    if not gens:
        return {"generations": [], "llm_output": res.llm_output}
    if isinstance(gens[0], list):
        rows: list[list[Any]] = gens  # type: ignore[assignment]
    else:
        rows = [gens]
    for row in rows:
        inner: list[dict[str, Any]] = []
        for g in row:
            msg = getattr(g, "message", None)
            inner.append(
                {
                    "type": getattr(g, "type", "ChatGeneration"),
                    "text": getattr(g, "text", "") or "",
                    "generation_info": getattr(g, "generation_info", None),
                    "message": message_to_dict(msg) if msg is not None else None,
                }
            )
        generations_out.append(inner)
    return {"generations": generations_out, "llm_output": res.llm_output}


def complete_vendor_roundtrip(
    *,
    chat_result: ChatResult | None,
    latency_ms: float,
    error: BaseException | None = None,
    raw_extra: dict[str, Any] | None = None,
    first_token_latency_ms: float | None = None,
) -> None:
    """Pop the stack entry pushed for this call and persist request + response (best-effort)."""
    pending = _pop_vendor_request()
    if pending is None:
        return

    provider = str(pending.get("provider") or "")
    model = pending.get("model")
    vendor_request = pending.get("payload")

    ended_ms = int(time.time() * 1000)
    response_body: dict[str, Any] | None = None
    if chat_result is not None:
        response_body = _serialize_chat_result(chat_result)
        if raw_extra:
            response_body = {**response_body, **raw_extra}
    elif raw_extra:
        response_body = dict(raw_extra)

    if error is not None:
        err_payload = {"type": type(error).__name__, "message": str(error)}
        if response_body is None:
            response_body = {"error": err_payload}
        else:
            response_body["error"] = err_payload

    ik = str(pending.get("invocation_kind") or "").strip() or None
    record = {
        "ts_ms": ended_ms,
        "provider": provider,
        "model": model,
        "latency_ms": round(float(latency_ms), 3),
        "invocation_kind": ik,
        "vendor_request": vendor_request,
        "response": response_body,
    }

    tid = None
    try:
        from evoflow.models.request_payload_logger import _thread_id_for_log

        tid = _thread_id_for_log()
        if tid:
            record["thread_id"] = tid
    except Exception:
        pass

    try:
        from evoflow.observability.recorder import get_observability_recorder

        trace_id = None
        try:
            from evoflow.models.request_payload_logger import _extract_trace_id

            if isinstance(vendor_request, dict):
                trace_id = _extract_trace_id(vendor_request)
        except Exception:
            pass
        if not trace_id:
            try:
                if isinstance(vendor_request, dict):
                    ctx = vendor_request.get("context")
                    if isinstance(ctx, dict):
                        t = ctx.get("evf_trace_id")
                        if isinstance(t, str) and t.strip():
                            trace_id = t.strip()
            except Exception:
                pass

        pushed_ms = pending.get("pushed_at_ms")
        if isinstance(pushed_ms, int) and pushed_ms > 0:
            req_iso = instant_to_beijing_iso(pushed_ms)
        else:
            req_iso = instant_to_beijing_iso(ended_ms)
        run_id = None
        try:
            from langgraph.config import get_config

            cfg = get_config()
            c = cfg.get("configurable") if isinstance(cfg, dict) else {}
            if isinstance(c, dict) and isinstance(c.get("run_id"), str):
                run_id = c["run_id"].strip() or None
        except Exception:
            pass

        request_json = None
        thinking_fields: dict[str, Any] = {}
        if vendor_request is not None:
            try:
                from evoflow.observability.thinking_context import (
                    infer_thinking_from_vendor_payload,
                    merge_thinking_context,
                    thinking_fields_for_sqlite,
                )

                phase1_record = pending.get("phase1_record")
                runtime_thinking = None
                if isinstance(phase1_record, dict):
                    eth = phase1_record.get("evoflow_thinking")
                    if isinstance(eth, dict):
                        runtime_thinking = eth.get("runtime") or eth
                vendor_inferred = infer_thinking_from_vendor_payload(vendor_request)
                thinking_fields = thinking_fields_for_sqlite(
                    merge_thinking_context(runtime_thinking, vendor_inferred)
                )
            except Exception:
                pass
            request_json = serialize_vendor_request_json(vendor_request)
        response_json = None
        if response_body is not None:
            try:
                obs_resp = build_observability_response_record(response_body)
                response_json = _cap_json_str(json.dumps(obs_resp, ensure_ascii=False, default=str))
            except Exception:
                response_json = _cap_json_str(json.dumps(response_body, ensure_ascii=False, default=str))
        usage_json = None
        if chat_result is not None:
            usage_blob = _usage_blob_for_sqlite(chat_result)
            try:
                from evoflow.observability.compaction_run_context import merge_compaction_into_usage

                usage_blob = merge_compaction_into_usage(usage_blob, invocation_kind=ik)
            except Exception:
                pass
            if usage_blob:
                usage_json = _cap_json_str(json.dumps(usage_blob, ensure_ascii=False, default=str))

        cache_read_tokens = cache_creation_tokens = cache_miss_tokens = None
        if usage_blob:
            try:
                from evoflow.observability.queries import cache_tokens_from_usage_payload

                cache_fields = cache_tokens_from_usage_payload(usage_blob)
                cache_read_tokens = cache_fields.get("cache_read_tokens")
                cache_creation_tokens = cache_fields.get("cache_creation_tokens")
                cache_miss_tokens = cache_fields.get("cache_miss_tokens")
            except Exception:
                pass

        model_call_seq = None
        try:
            from evoflow.observability.run_latency_trace import resolve_obs_chat_message_seq

            model_call_seq = resolve_obs_chat_message_seq(thread_id=tid)
        except Exception:
            pass

        pending_row_id = pending.get("pending_row_id")
        if pending_row_id:
            # Phase 2: UPDATE the 'running' row inserted in Phase 1.
            get_observability_recorder().record_model_invocation_complete(
                row_id=pending_row_id,
                latency_ms=float(latency_ms),
                first_token_latency_ms=first_token_latency_ms,
                response_json=response_json,
                usage_json=usage_json,
                cache_read_tokens=cache_read_tokens,
                cache_creation_tokens=cache_creation_tokens,
                cache_miss_tokens=cache_miss_tokens,
                status="error" if error is not None else "completed",
                request_json=request_json,
                **thinking_fields,
            )
        else:
            # Fallback: no Phase 1 row was created — insert a complete row.
            get_observability_recorder().record_model_request_payload(
                thread_id=tid,
                run_id=run_id,
                model_call_seq=model_call_seq,
                provider=provider or "unknown",
                model=str(model) if model is not None else None,
                stage="vendor_roundtrip",
                trace_id=trace_id,
                requested_at=req_iso,
                latency_ms=float(latency_ms),
                first_token_latency_ms=first_token_latency_ms,
                request_json=request_json,
                response_json=response_json,
                usage_json=usage_json,
                cache_read_tokens=cache_read_tokens,
                cache_creation_tokens=cache_creation_tokens,
                cache_miss_tokens=cache_miss_tokens,
                collab_phase=None,
                checkpoint_id=None,
                invocation_kind=str(pending.get("invocation_kind") or "").strip() or None,
                **thinking_fields,
            )
    except Exception:
        logger.debug("vendor_roundtrip sqlite insert failed", exc_info=True)


class VendorRoundtripChatMixin:
    """Wrap sync/async generate and stream paths to flush vendor roundtrip logs."""

    def _generate(
        self,
        messages: list[Any],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        t0 = time.perf_counter()
        try:
            res = _ensure_chat_result(
                super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)  # type: ignore[misc]
            )
            complete_vendor_roundtrip(chat_result=res, latency_ms=(time.perf_counter() - t0) * 1000.0, error=None)
            return res
        except Exception as e:
            _attach_model_to_exception(e, self)
            complete_vendor_roundtrip(chat_result=None, latency_ms=(time.perf_counter() - t0) * 1000.0, error=e)
            raise

    async def _agenerate(
        self,
        messages: list[Any],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        t0 = time.perf_counter()
        try:
            res = await super()._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)  # type: ignore[misc]
            complete_vendor_roundtrip(chat_result=res, latency_ms=(time.perf_counter() - t0) * 1000.0, error=None)
            # Log empty or suspicious results
            if res and res.generations:
                gen = res.generations[0]
                msg = getattr(gen, "message", None)
                if msg is not None:
                    content = getattr(msg, "content", "")
                    tool_calls = getattr(msg, "tool_calls", None)
                    usage = getattr(msg, "usage_metadata", None)
                    if not content and not tool_calls:
                        logger.warning(
                            "vendor _agenerate returned empty result: content=%r tool_calls=%s usage=%s latency_ms=%.0f",
                            content,
                            tool_calls,
                            usage,
                            (time.perf_counter() - t0) * 1000.0,
                        )
            return res
        except Exception as e:
            _attach_model_to_exception(e, self)
            logger.warning(
                "vendor _agenerate raised exception: %s: %s latency_ms=%.0f",
                type(e).__name__,
                str(e)[:300],
                (time.perf_counter() - t0) * 1000.0,
            )
            complete_vendor_roundtrip(chat_result=None, latency_ms=(time.perf_counter() - t0) * 1000.0, error=e)
            raise

    def _stream(self, messages: list[Any], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any):  # type: ignore[override]
        attempts = _stream_retry_attempts()
        for attempt in range(attempts):
            t0 = time.perf_counter()
            ttft: float | None = None
            acc: ChatGenerationChunk | None = None
            try:
                for gen_chunk in super()._stream(messages, stop=stop, run_manager=run_manager, **kwargs):  # type: ignore[misc]
                    if ttft is None:
                        ttft = (time.perf_counter() - t0) * 1000.0
                    acc = gen_chunk if acc is None else acc + gen_chunk
                    yield gen_chunk
            except Exception as e:
                _attach_model_to_exception(e, self)
                if _is_retriable_stream_error(e) and attempt + 1 < attempts:
                    logger.warning(
                        "vendor _stream retry %d/%d after %s: %s",
                        attempt + 1,
                        attempts,
                        type(e).__name__,
                        str(e)[:200],
                    )
                    time.sleep(_stream_retry_backoff_seconds(attempt))
                    continue
                complete_vendor_roundtrip(
                    chat_result=None,
                    latency_ms=(time.perf_counter() - t0) * 1000.0,
                    error=e,
                    first_token_latency_ms=ttft,
                )
                raise
            else:
                try:
                    if acc is not None and getattr(acc, "message", None) is not None:
                        from langchain_core.outputs import ChatGeneration

                        msg = acc.message
                        gen_info = getattr(acc, "generation_info", None)
                        cr = ChatResult(generations=[ChatGeneration(message=msg, generation_info=gen_info)], llm_output={})
                        complete_vendor_roundtrip(
                            chat_result=cr,
                            latency_ms=(time.perf_counter() - t0) * 1000.0,
                            error=None,
                            first_token_latency_ms=ttft,
                        )
                    else:
                        complete_vendor_roundtrip(
                            chat_result=None,
                            latency_ms=(time.perf_counter() - t0) * 1000.0,
                            error=None,
                            first_token_latency_ms=ttft,
                        )
                except Exception as e:
                    logger.debug("vendor_roundtrip stream finalize failed", exc_info=True)
                    complete_vendor_roundtrip(
                        chat_result=None,
                        latency_ms=(time.perf_counter() - t0) * 1000.0,
                        error=e,
                        first_token_latency_ms=ttft,
                    )
                return

    async def _astream(self, messages: list[Any], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any):  # type: ignore[override]
        attempts = _stream_retry_attempts()
        for attempt in range(attempts):
            try:
                async for chunk in self._astream_once(messages, stop=stop, run_manager=run_manager, **kwargs):
                    yield chunk
                return
            except Exception as e:
                if _is_retriable_stream_error(e) and attempt + 1 < attempts:
                    logger.warning(
                        "vendor _astream retry %d/%d after %s: %s",
                        attempt + 1,
                        attempts,
                        type(e).__name__,
                        str(e)[:200],
                    )
                    await asyncio.sleep(_stream_retry_backoff_seconds(attempt))
                    continue
                raise

    async def _astream_once(self, messages: list[Any], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any):  # type: ignore[override]
        from evoflow.platform.asyncio_windows import is_event_loop_closed_runtime_error

        t0 = time.perf_counter()
        ttft: float | None = None
        acc: ChatGenerationChunk | None = None
        chunk_count = 0

        # Watchdog: max total stream duration. Prevents reasoning models from
        # streaming thinking tokens indefinitely when the upstream API is stuck.
        # Default 300s is generous enough for long reasoning, but catches true hangs.
        stream_total_timeout = float(os.environ.get("EVOFLOW_STREAM_TOTAL_TIMEOUT_S", "300"))

        try:
            async with asyncio.timeout(stream_total_timeout):
                async for gen_chunk in super()._astream(messages, stop=stop, run_manager=run_manager, **kwargs):  # type: ignore[misc]
                    chunk_count += 1
                    if ttft is None:
                        ttft = (time.perf_counter() - t0) * 1000.0
                    # Log chunk content for debugging empty responses
                    if chunk_count <= 5:  # Only log first 5 chunks to avoid spam
                        logger.info(
                            "vendor _astream chunk[%d]: %s",
                            chunk_count,
                            repr(gen_chunk),
                        )
                    acc = gen_chunk if acc is None else acc + gen_chunk
                    yield gen_chunk
        except RuntimeError as e:
            if is_event_loop_closed_runtime_error(e) and acc is not None:
                logger.warning(
                    "vendor astream: event loop closed after stream body; preserving streamed chunks (chunk_count=%d)",
                    chunk_count,
                )
                try:
                    if getattr(acc, "message", None) is not None:
                        from langchain_core.outputs import ChatGeneration

                        msg = acc.message
                        gen_info = getattr(acc, "generation_info", None)
                        cr = ChatResult(
                            generations=[ChatGeneration(message=msg, generation_info=gen_info)],
                            llm_output={},
                        )
                        complete_vendor_roundtrip(
                            chat_result=cr,
                            latency_ms=(time.perf_counter() - t0) * 1000.0,
                            error=None,
                            first_token_latency_ms=ttft,
                        )
                except Exception as fin:
                    logger.debug("vendor_roundtrip astream loop-closed finalize failed", exc_info=True)
                    complete_vendor_roundtrip(
                        chat_result=None,
                        latency_ms=(time.perf_counter() - t0) * 1000.0,
                        error=fin,
                        first_token_latency_ms=ttft,
                    )
                return
            complete_vendor_roundtrip(
                chat_result=None,
                latency_ms=(time.perf_counter() - t0) * 1000.0,
                error=e,
                first_token_latency_ms=ttft,
            )
            logger.warning(
                "vendor _astream raised RuntimeError (non-loop-closed): %s: %s chunk_count=%d latency_ms=%.0f",
                type(e).__name__,
                str(e)[:300],
                chunk_count,
                (time.perf_counter() - t0) * 1000.0,
            )
            raise
        except Exception as e:
            _attach_model_to_exception(e, self)
            logger.warning(
                "vendor _astream raised exception: %s: %s chunk_count=%d latency_ms=%.0f",
                type(e).__name__,
                str(e)[:300],
                chunk_count,
                (time.perf_counter() - t0) * 1000.0,
            )
            complete_vendor_roundtrip(chat_result=None, latency_ms=(time.perf_counter() - t0) * 1000.0, error=e, first_token_latency_ms=ttft)
            raise
        else:
            logger.info(
                "vendor _astream completed: chunk_count=%d has_acc=%s ttft_ms=%s latency_ms=%.0f",
                chunk_count,
                acc is not None,
                f"{ttft:.1f}" if ttft else "None",
                (time.perf_counter() - t0) * 1000.0,
            )
            try:
                if acc is not None and getattr(acc, "message", None) is not None:
                    from langchain_core.outputs import ChatGeneration

                    msg = acc.message
                    gen_info = getattr(acc, "generation_info", None)
                    cr = ChatResult(generations=[ChatGeneration(message=msg, generation_info=gen_info)], llm_output={})
                    complete_vendor_roundtrip(chat_result=cr, latency_ms=(time.perf_counter() - t0) * 1000.0, error=None, first_token_latency_ms=ttft)
                else:
                    complete_vendor_roundtrip(chat_result=None, latency_ms=(time.perf_counter() - t0) * 1000.0, error=None, first_token_latency_ms=ttft)
            except Exception as e:
                logger.debug("vendor_roundtrip astream finalize failed", exc_info=True)
                complete_vendor_roundtrip(chat_result=None, latency_ms=(time.perf_counter() - t0) * 1000.0, error=e, first_token_latency_ms=ttft)
