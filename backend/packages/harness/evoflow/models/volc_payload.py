"""Volcengine Ark OpenAI-compat request payload adjustments."""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlparse


def _is_volcengine_base_url(base_url: str | None) -> bool:
    raw = str(base_url or "").strip().lower()
    if not raw:
        return False
    host = (urlparse(raw).hostname or "").lower()
    return ("volces.com" in host) or ("volcengine" in host)


def _normalize_reasoning_effort(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, dict):
        value = value.get("effort")
    s = str(value).strip().lower()
    if not s or s in ("none",):
        return None
    if s == "x-high":
        s = "xhigh"
    return s


def _resolve_reasoning_effort(payload: dict[str, Any]) -> str | None:
    effort = _normalize_reasoning_effort(payload.get("reasoning_effort"))
    if effort:
        return effort
    reasoning = payload.get("reasoning")
    if isinstance(reasoning, dict):
        effort = _normalize_reasoning_effort(reasoning.get("effort"))
        if effort:
            return effort
    extra = payload.get("extra_body")
    if isinstance(extra, dict):
        reasoning = extra.get("reasoning")
        if isinstance(reasoning, dict):
            effort = _normalize_reasoning_effort(reasoning.get("effort"))
            if effort:
                return effort
    return None


def _resolve_thinking_dict(payload: dict[str, Any]) -> dict[str, Any] | None:
    thinking = payload.get("thinking")
    if isinstance(thinking, dict):
        return dict(thinking)
    extra = payload.get("extra_body")
    if isinstance(extra, dict):
        nested = extra.get("thinking")
        if isinstance(nested, dict):
            return dict(nested)
    return None


def _clean_thinking_type(thinking: dict[str, Any]) -> dict[str, Any]:
    t = str(thinking.get("type") or "").strip().lower()
    if t in ("disabled", "off", "none"):
        return {"type": "disabled"}
    if t in ("auto",):
        return {"type": "auto"}
    if t in ("enabled", "on"):
        return {"type": "enabled"}
    return {"type": t or "enabled"}


def _should_use_volc_modern_chat_api(payload: dict[str, Any]) -> bool:
    """True when the payload targets Volc Chat API (Seed 2.x / GLM 5.2), not legacy ``budget_tokens``."""
    if _resolve_reasoning_effort(payload):
        return True
    thinking = _resolve_thinking_dict(payload)
    if not isinstance(thinking, dict):
        return False
    t = str(thinking.get("type") or "").strip().lower()
    if t not in ("enabled", "disabled", "auto", "on", "off", "none"):
        return False
    budget = thinking.get("budget_tokens") if thinking.get("budget_tokens") is not None else thinking.get("budgetTokens")
    return budget is None


def _uses_volc_modern_reasoning_api(payload: dict[str, Any]) -> bool:
    """Alias kept for tests / callers: modern API marker present."""
    return _should_use_volc_modern_chat_api(payload)


def _thinking_enabled(payload: dict[str, Any]) -> bool:
    thinking = _resolve_thinking_dict(payload)
    if not isinstance(thinking, dict):
        return False
    t = str(thinking.get("type") or "").strip().lower()
    return t in ("enabled", "auto", "on")


def _as_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _answer_reserve_tokens(combined_ceiling: int) -> int:
    raw = os.environ.get("EVOFLOW_VOLC_COMPLETION_RESERVE_TOKENS", "").strip()
    if raw:
        try:
            return max(1024, int(raw))
        except ValueError:
            pass
    return max(16384, combined_ceiling // 4, 8192)


def _merge_vendor_extra_body(payload: dict[str, Any], fields: dict[str, Any]) -> None:
    """Vendor extensions must live under ``extra_body`` for LangChain ChatOpenAI / OpenAI SDK."""
    extra = dict(payload.get("extra_body") or {})
    for key, value in fields.items():
        if value is None:
            extra.pop(key, None)
        else:
            extra[key] = value
    if extra:
        payload["extra_body"] = extra
    else:
        payload.pop("extra_body", None)
    for key in ("thinking", "reasoning", "reasoning_effort"):
        payload.pop(key, None)


def normalize_volcengine_modern_chat_request(payload: dict[str, Any], *, base_url: str | None) -> dict[str, Any]:
    """Rewrite LangChain payload to official Volc Chat API fields (via ``extra_body``).

    LangChain forwards unknown top-level keys to ``AsyncCompletions.create()`` and rejects
    ``thinking`` / ``reasoning``; the OpenAI SDK merges ``extra_body`` into the HTTP JSON.
    """
    if not _is_volcengine_base_url(base_url):
        return payload

    effort = _resolve_reasoning_effort(payload)
    thinking_raw = _resolve_thinking_dict(payload)
    if thinking_raw is None and effort is None:
        payload.pop("reasoning_effort", None)
        _merge_vendor_extra_body(payload, {})
        return payload

    thinking = _clean_thinking_type(thinking_raw or {"type": "enabled"})
    vendor: dict[str, Any] = {}
    if effort in ("minimal", "none") or thinking.get("type") == "disabled":
        vendor["thinking"] = {"type": "disabled"}
    else:
        vendor["thinking"] = thinking
        if effort and thinking.get("type") != "disabled":
            vendor["reasoning"] = {"effort": effort}
    _merge_vendor_extra_body(payload, vendor)
    return payload


def apply_volcengine_thinking_output_limits(payload: dict[str, Any], *, base_url: str | None) -> dict[str, Any]:
    """Legacy Volc models: split ``max_completion_tokens`` vs ``thinking.budget_tokens``."""
    if not _is_volcengine_base_url(base_url) or not _thinking_enabled(payload):
        return payload

    combined = _as_int(payload.pop("max_completion_tokens", None))
    if combined is None:
        combined = _as_int(payload.get("max_tokens"))
    if combined is None or combined <= 0:
        return payload

    extra = dict(payload.get("extra_body") or {})
    thinking = dict(extra.get("thinking") or {})
    budget = _as_int(thinking.get("budget_tokens") or thinking.get("budgetTokens"))
    if budget is None or budget <= 0:
        budget = max(4096, combined - _answer_reserve_tokens(combined))

    reserve = min(_answer_reserve_tokens(combined), combined)
    if budget + reserve > combined:
        budget = max(4096, combined - reserve)

    thinking["type"] = thinking.get("type") or "enabled"
    thinking["budget_tokens"] = int(budget)
    extra["thinking"] = thinking
    payload["extra_body"] = extra
    payload.pop("max_completion_tokens", None)
    payload["max_tokens"] = int(reserve)
    return payload


def apply_volcengine_request_payload(payload: dict[str, Any], *, base_url: str | None) -> dict[str, Any]:
    """Apply Volc-specific request normalization before HTTP + observability logging."""
    if not _is_volcengine_base_url(base_url):
        return payload
    if _should_use_volc_modern_chat_api(payload):
        return normalize_volcengine_modern_chat_request(payload, base_url=base_url)
    return apply_volcengine_thinking_output_limits(payload, base_url=base_url)
