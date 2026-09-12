from __future__ import annotations

import json
import os
import time
from typing import Any

from evoflow.timeutil import instant_to_beijing_iso

_MAX_FIELD_LEN = 4000
# 系统提示、instructions、顶层 system 等允许更长（调试日志）；可用环境变量覆盖。
_DEFAULT_SYSTEM_BODY_MAX = 2_000_000


def _max_system_body_chars() -> int:
    raw = os.environ.get("EVOFLOW_MODEL_REQUEST_LOG_SYSTEM_BODY_MAX_CHARS", "").strip()
    if not raw:
        return _DEFAULT_SYSTEM_BODY_MAX
    try:
        n = int(raw)
        return max(4000, n)
    except ValueError:
        return _DEFAULT_SYSTEM_BODY_MAX


def _max_system_prompt_full_record_chars() -> int:
    """写入 ``system_prompt_full`` 字段的上限（从原始 payload 抽取，与截断后的 payload 无关）。"""
    raw = os.environ.get("EVOFLOW_MODEL_REQUEST_LOG_SYSTEM_PROMPT_MAX_CHARS", "").strip()
    if raw in ("0", "unlimited", "none"):
        return 0
    if not raw:
        return _DEFAULT_SYSTEM_BODY_MAX
    try:
        n = int(raw)
        return max(0, n)
    except ValueError:
        return _DEFAULT_SYSTEM_BODY_MAX


def _thread_id_for_log() -> str | None:
    """Best-effort LangGraph thread id for correlating debug views (may be empty outside a run)."""
    try:
        from langgraph.config import get_config

        tid = str(get_config().get("configurable", {}).get("thread_id") or "").strip()
        return tid or None
    except Exception:
        return None


def _agent_codes_for_log() -> tuple[str | None, str | None]:
    """Best-effort (agent_code, position_code) from LangGraph configurable / runtime context.

    Proactive runs pass codes via ``context`` (not ``configurable``), so we also
    try ``langgraph.runtime.get_runtime()`` when available. Returns ``(None, None)``
    outside a run or when codes are not set (e.g. main chat without an agent_id).
    """
    agent_code: str | None = None
    position_code: str | None = None
    # 1) configurable (main chat / task execution runs)
    try:
        from langgraph.config import get_config

        c = get_config().get("configurable") or {}
        if isinstance(c, dict):
            agent_code = str(c.get("agent_id") or c.get("agent_code") or "").strip() or None
            position_code = str(c.get("position_code") or "").strip() or None
    except Exception:
        pass
    # 2) runtime context (proactive employee runs - codes passed via context)
    if not agent_code or not position_code:
        try:
            from langgraph.runtime import get_runtime

            from evoflow.agents.lead_agent.runtime_context import runtime_context_mapping

            ctx = runtime_context_mapping(get_runtime())
            if not agent_code:
                agent_code = (
                    str(ctx.get("agent_id") or ctx.get("proactive_agent_code") or "").strip() or None
                )
            if not position_code:
                position_code = str(ctx.get("position_code") or "").strip() or None
        except Exception:
            pass
    return agent_code, position_code


def _effective_log_invocation_kind(model_explicit: str | None) -> str | None:
    """Resolve observability label: hosted auto-follow runs use the same chat model as ``main``."""
    ik = (model_explicit or "").strip() or "main"
    if ik != "main":
        return ik
    try:
        from langgraph.config import get_config

        cfg = get_config()
        c = cfg.get("configurable") if isinstance(cfg, dict) else {}
        if isinstance(c, dict) and str(c.get("prompt_source") or "").strip() in {
            "goal",
            "goal_controller",
            "hosted_autofollow",
        }:
            return "hosted"
    except Exception:
        pass
    return ik


def _extract_trace_id(payload: dict[str, Any]) -> str | None:
    context = payload.get("context")
    if isinstance(context, dict):
        tid = context.get("evf_trace_id")
        if isinstance(tid, str) and tid.strip():
            return tid.strip()

    metadata = payload.get("metadata")
    if isinstance(metadata, dict):
        for key in ("evf_trace_id", "trace_id"):
            tid = metadata.get(key)
            if isinstance(tid, str) and tid.strip():
                return tid.strip()

    for key in ("evf_trace_id", "trace_id"):
        tid = payload.get(key)
        if isinstance(tid, str) and tid.strip():
            return tid.strip()

    return None


def _truncate_inner(value: Any, *, system_body: bool) -> Any:
    """``system_body=True`` 时使用更长上限，便于调试页展示完整系统提示（仍防单字段爆内存）。"""
    cap = _max_system_body_chars() if system_body else _MAX_FIELD_LEN
    if isinstance(value, str):
        if cap == 0 or len(value) <= cap:
            return value
        return value[:cap] + f"...<truncated:{len(value)}>"
    if isinstance(value, list):
        return [_truncate_inner(v, system_body=system_body) for v in value]
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            lk = str(k).lower()
            if lk in {"authorization", "api_key", "x-api-key", "token", "access_token"}:
                out[k] = "<redacted>"
            else:
                out[k] = _truncate_inner(v, system_body=system_body)
        return out
    return value


def _truncate_message_entry(msg: Any) -> Any:
    if not isinstance(msg, dict):
        return _truncate_inner(msg, system_body=False)
    role = str(msg.get("role") or "").strip().lower()
    if role != "system":
        return _truncate_inner(msg, system_body=False)
    out: dict[str, Any] = {}
    for sk, sv in msg.items():
        if sk == "content":
            out[sk] = _truncate_inner(sv, system_body=True)
        else:
            out[sk] = _truncate_inner(sv, system_body=False)
    return out


def _log_payload_truncate_enabled() -> bool:
    """默认不截断字段长度（仅脱敏）；设 ``EVOFLOW_MODEL_REQUEST_LOG_TRUNCATE=1`` 恢复旧行为。"""
    raw = os.environ.get("EVOFLOW_MODEL_REQUEST_LOG_TRUNCATE", "").strip().lower()
    return raw in ("1", "true", "yes", "on")


def _redact_payload_secrets(value: Any) -> Any:
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            lk = str(k).lower()
            if lk in {"authorization", "api_key", "x-api-key", "token", "access_token"}:
                out[k] = "<redacted>"
            else:
                out[k] = _redact_payload_secrets(v)
        return out
    if isinstance(value, list):
        return [_redact_payload_secrets(v) for v in value]
    return value


def _truncate_payload_for_log(payload: dict[str, Any]) -> dict[str, Any]:
    """整包截断：普通字段 4k；``instructions``、顶层 ``system``、``role=system`` 的 ``content`` 用长上限。"""
    if not _log_payload_truncate_enabled():
        redacted = _redact_payload_secrets(payload)
        return redacted if isinstance(redacted, dict) else payload
    out: dict[str, Any] = {}
    for k, v in payload.items():
        lk = str(k).lower()
        if lk in {"authorization", "api_key", "x-api-key", "token", "access_token"}:
            out[k] = "<redacted>" if isinstance(v, str) else _truncate_inner(v, system_body=False)
            continue
        if k == "messages" and isinstance(v, list):
            out[k] = [_truncate_message_entry(m) for m in v]
        elif k == "system":
            out[k] = _truncate_inner(v, system_body=True)
        elif k == "instructions":
            out[k] = _truncate_inner(v, system_body=True)
        else:
            out[k] = _truncate_inner(v, system_body=False)
    return out


def _message_content_to_plain_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict):
                typ = str(block.get("type") or "").lower()
                t = block.get("text")
                if isinstance(t, str) and t.strip():
                    parts.append(t.strip())
                elif typ in {"text", "input_text", "output_text"} and isinstance(t, str):
                    parts.append(str(t).strip())
            elif isinstance(block, str) and block.strip():
                parts.append(block.strip())
        return "\n".join(parts)
    if isinstance(content, dict):
        pts = content.get("parts")
        if isinstance(pts, list):
            return _message_content_to_plain_text(pts)
        t = content.get("text")
        if isinstance(t, str):
            return t
    return ""


def _anthropic_style_system_to_text(system: Any) -> str:
    if system is None:
        return ""
    if isinstance(system, str):
        return system
    if isinstance(system, list):
        return "\n\n".join(x for x in (_message_content_to_plain_text(b) for b in system) if x)
    if isinstance(system, dict):
        return _message_content_to_plain_text(system)
    return ""


def _dedupe_identical_system_segments(segments: list[str]) -> list[str]:
    """多轮会在 state 里重复追加同名协作提示等；按正文去重，保留首次出现顺序。"""
    seen: set[str] = set()
    out: list[str] = []
    for s in segments:
        key = s.strip()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


def extract_system_prompt_full_from_vendor_payload(payload: dict[str, Any]) -> str:
    """与调试 UI 一致：合并 instructions、顶层 system、全部 system/developer 角色消息（未截断的厂商体）。"""
    segments: list[str] = []
    ins = payload.get("instructions")
    if isinstance(ins, str) and ins.strip():
        segments.append(ins.strip())
    top = _anthropic_style_system_to_text(payload.get("system")).strip()
    if top:
        segments.append(top)
    messages = payload.get("messages")
    if isinstance(messages, list):
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            role = str(msg.get("role") or "").strip().lower()
            if role not in {"system", "developer"}:
                continue
            piece = _message_content_to_plain_text(msg.get("content")).strip()
            if piece:
                segments.append(piece)
    segments = _dedupe_identical_system_segments(segments)
    if not segments:
        return ""
    if len(segments) == 1:
        return segments[0]
    n = len(segments)
    parts: list[str] = [segments[0]]
    for i, seg in enumerate(segments[1:], start=2):
        parts.append(f"──────── system segment {i}/{n} ────────\n\n{seg}")
    return "\n\n".join(parts)


def extract_effective_system_prompt_for_ui(payload: dict[str, Any]) -> str:
    """System/developer/instructions first; else first user message (memory/mission_state templates)."""
    full = extract_system_prompt_full_from_vendor_payload(payload)
    if full:
        return full
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return ""
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        if str(msg.get("role") or "").strip().lower() != "user":
            continue
        text = _message_content_to_plain_text(msg.get("content")).strip()
        if text:
            return text
        break
    return ""


def _normalize_vendor_message_role(msg: dict[str, Any]) -> str:
    role = str(msg.get("role") or "").strip().lower()
    if role in {"user", "human"}:
        return "user"
    if role in {"system", "developer"}:
        return "system"
    typ = str(msg.get("type") or "").strip().lower()
    if typ in {"human", "humanmessage"}:
        return "user"
    if typ in {"system", "systemmessage"}:
        return "system"
    return role


def _unwrap_vendor_message_dict(msg: dict[str, Any]) -> dict[str, Any]:
    data = msg.get("data")
    if isinstance(data, dict) and msg.get("type") is not None:
        return data
    kwargs = msg.get("kwargs")
    if isinstance(kwargs, dict):
        return kwargs
    return msg


def extract_latest_user_preview_from_vendor_payload(payload: dict[str, Any]) -> str:
    """Latest non-summary user message from vendor HTTP body (for observability UI)."""
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return ""
    for msg in reversed(messages):
        if not isinstance(msg, dict):
            continue
        body = _unwrap_vendor_message_dict(msg)
        if _normalize_vendor_message_role(body) != "user":
            continue
        name = str(body.get("name") or "").strip()
        if name == "conversation_summary":
            continue
        text = _message_content_to_plain_text(body.get("content")).strip()
        if text:
            return text
    return ""


def tool_names_from_vendor_payload(payload: dict[str, Any]) -> list[str]:
    """Tool schema names from vendor ``tools`` array (no descriptions)."""
    out: list[str] = []
    seen: set[str] = set()
    tools = payload.get("tools")
    if not isinstance(tools, list):
        return out
    for t in tools:
        if not isinstance(t, dict):
            continue
        fn = t.get("function")
        if isinstance(fn, dict):
            name = str(fn.get("name") or "").strip()
        else:
            name = str(t.get("name") or "").strip()
        if name and name not in seen:
            seen.add(name)
            out.append(name)
    return out


def text_content_stats(text: str, *, model: str | None = None) -> dict[str, int]:
    """Character and token estimates for observability UI badges.

    Token counting must never block the Gateway event loop. When the tiktoken
    BPE table is not yet cached, ``count_text_tokens`` degrades to a heuristic
    (or 0 on unexpected errors) so observability cannot stall model requests.
    """
    from evoflow.context.compaction_token_utils import count_text_tokens

    body = str(text or "")
    if not body:
        return {"chars": 0, "tokens": 0}
    try:
        tokens = int(count_text_tokens(body, model=model))
    except Exception:
        tokens = 0
    return {"chars": len(body), "tokens": tokens}


def tool_stats_from_vendor_payload(payload: dict[str, Any], *, model: str | None = None) -> list[dict[str, Any]]:
    """Per-tool wire-schema size (chars + tokens) from vendor ``tools`` array."""
    from evoflow.context.compaction_token_utils import count_text_tokens

    tools = payload.get("tools")
    if not isinstance(tools, list):
        return []
    stats: list[dict[str, Any]] = []
    seen: set[str] = set()
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        fn = tool.get("function")
        if isinstance(fn, dict):
            name = str(fn.get("name") or "").strip()
        else:
            name = str(tool.get("name") or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        try:
            blob = json.dumps(tool, ensure_ascii=False, separators=(",", ":"), default=str)
        except Exception:
            blob = str(tool)
        try:
            tokens = int(count_text_tokens(blob, model=model))
        except Exception:
            tokens = 0
        stats.append(
            {
                "name": name,
                "chars": len(blob),
                "tokens": tokens,
            }
        )
    return stats


def _maybe_cap_system_prompt_full_record(text: str) -> str:
    cap = _max_system_prompt_full_record_chars()
    if cap == 0 or len(text) <= cap:
        return text
    return text[:cap] + f"...<truncated:{len(text)}>"


def _extract_system_prompt_preview(payload: dict[str, Any]) -> tuple[bool, str]:
    """Best-effort detect system prompt from provider payload."""
    # Responses-style payloads (e.g. instructions)
    instructions = payload.get("instructions")
    if isinstance(instructions, str) and instructions.strip():
        return True, instructions.strip()

    # Chat-style payloads
    messages = payload.get("messages")
    if isinstance(messages, list):
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            role = str(msg.get("role") or "").strip().lower()
            if role != "system":
                continue
            content = msg.get("content")
            if isinstance(content, str) and content.strip():
                return True, content.strip()
            if isinstance(content, list):
                parts: list[str] = []
                for block in content:
                    if isinstance(block, dict):
                        t = block.get("text")
                        if isinstance(t, str) and t.strip():
                            parts.append(t.strip())
                    elif isinstance(block, str) and block.strip():
                        parts.append(block.strip())
                merged = " ".join(parts).strip()
                if merged:
                    return True, merged
    return False, ""


def log_model_request_payload(
    provider: str,
    model: str | None,
    payload: dict[str, Any],
    *,
    stage: str = "final_payload",
    invocation_kind: str | None = None,
    model_instance: Any | None = None,
) -> None:
    try:
        ts_ms = int(time.time() * 1000)
        from evoflow.observability.provider_labels import resolve_observability_provider

        provider = resolve_observability_provider(
            fallback=provider,
            model=model,
            model_instance=model_instance,
        )
        trace_id = _extract_trace_id(payload)
        has_system_prompt, system_preview = _extract_system_prompt_preview(payload)
        ik_resolved = (invocation_kind or "").strip() or _effective_log_invocation_kind(model)
        record: dict[str, Any] = {
            "ts_ms": ts_ms,
            "provider": provider,
            "model": model,
            "stage": stage,
            "trace_id": trace_id,
            "invocation_kind": (ik_resolved or "").strip() or None,
            "system_prompt_detected": has_system_prompt,
            "system_prompt_preview": system_preview,
            "payload": _truncate_payload_for_log(payload),
        }
        tid = _thread_id_for_log()
        if tid:
            record["thread_id"] = tid
        try:
            from evoflow.observability.thinking_context import (
                collect_runtime_thinking_context,
                infer_thinking_from_vendor_payload,
                merge_thinking_context,
            )

            runtime_thinking = collect_runtime_thinking_context(model_instance)
            vendor_thinking = infer_thinking_from_vendor_payload(payload)
            record["evoflow_thinking"] = merge_thinking_context(runtime_thinking, vendor_thinking)
        except Exception:
            pass
        try:
            from evoflow.models.vendor_roundtrip import (
                prepare_vendor_request_for_observability,
                serialize_vendor_request_json,
            )

            vendor_body = prepare_vendor_request_for_observability(payload)
            vendor_request_json = serialize_vendor_request_json(vendor_body)
        except Exception:
            vendor_request_json = None
        # Phase 1: insert a 'running' row synchronously, then push onto the
        # vendor-roundtrip stack so complete_vendor_roundtrip can UPDATE it.
        pending_row_id = None
        try:
            from evoflow.observability.recorder import get_observability_recorder

            rec = get_observability_recorder()
            req_iso = instant_to_beijing_iso(ts_ms)
            run_id = None
            try:
                from langgraph.config import get_config

                cfg = get_config()
                c = cfg.get("configurable") if isinstance(cfg, dict) else {}
                if isinstance(c, dict) and isinstance(c.get("run_id"), str):
                    run_id = c["run_id"].strip() or None
            except Exception:
                pass
            model_call_seq = None
            try:
                from evoflow.observability.run_latency_trace import resolve_obs_chat_message_seq

                # Ops「序号」= chat messages table seq (not in-run model-call counter).
                model_call_seq = resolve_obs_chat_message_seq(thread_id=tid)
            except Exception:
                pass
            thinking_fields: dict[str, Any] = {}
            try:
                from evoflow.observability.thinking_context import thinking_fields_for_sqlite

                thinking_fields = thinking_fields_for_sqlite(record.get("evoflow_thinking"))
            except Exception:
                pass
            agent_code, position_code = _agent_codes_for_log()
            pending_row_id = rec.record_model_invocation_pending(
                thread_id=tid,
                run_id=run_id,
                model_call_seq=model_call_seq,
                provider=provider,
                model=model,
                stage=stage,
                trace_id=trace_id,
                requested_at=req_iso,
                request_json=vendor_request_json,
                collab_phase=None,
                checkpoint_id=None,
                invocation_kind=ik_resolved,
                agent_code=agent_code,
                position_code=position_code,
                **thinking_fields,
            )
        except Exception:
            pass

        # Always push onto the roundtrip stack (even when roundtrip logging
        # is disabled) so complete_vendor_roundtrip can find pending_row_id.
        try:
            from evoflow.models.vendor_roundtrip import push_vendor_request

            push_vendor_request(
                provider=provider,
                model=model,
                payload=payload,
                invocation_kind=invocation_kind,
                pending_row_id=pending_row_id,
                phase1_record=record,
            )
        except Exception:
            pass
    except Exception:
        # logging must never break request flow
        pass
