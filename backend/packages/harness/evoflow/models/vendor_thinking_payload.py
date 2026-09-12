"""Normalize thinking / reasoning fields per vendor before HTTP + observability logging."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from evoflow.models.volc_payload import (
    _merge_vendor_extra_body,
    _normalize_reasoning_effort,
    _resolve_reasoning_effort,
    _resolve_thinking_dict,
    apply_volcengine_request_payload,
)

# Mirrors factory._VOLC_THINKING_BUDGET_BY_EFFORT for DashScope thinking_budget.
_EFFORT_THINKING_BUDGET: dict[str, int] = {
    "minimal": 4096,
    "low": 8192,
    "medium": 16384,
    "high": 32768,
    "xhigh": 49152,
}


def _host(base_url: str | None) -> str:
    raw = str(base_url or "").strip().lower()
    host = (urlparse(raw).hostname or "").lower() if raw else ""
    if ("volces.com" in host) or ("volcengine" in host):
        return "volc"
    if ("dashscope" in host) or ("aliyuncs.com" in host):
        return "dashscope"
    if ("bigmodel.cn" in host) or ("zhipu" in host):
        return "zhipu"
    return ""


def _is_thinking_auto(model_instance: Any | None) -> bool:
    if model_instance is None:
        return False
    return str(getattr(model_instance, "_evoflow_thinking_type", "") or "").strip().lower() == "auto"


def _runtime_effort(payload: dict[str, Any], model_instance: Any | None) -> str | None:
    if model_instance is not None:
        raw = getattr(model_instance, "_evoflow_reasoning_effort", None)
        effort = _normalize_reasoning_effort(raw)
        if effort:
            return effort
        enabled = getattr(model_instance, "_evoflow_thinking_enabled", None)
        if enabled is False:
            # Auto = omit (vendor default); do not invent minimal/disable.
            if _is_thinking_auto(model_instance):
                return None
            return "minimal"
    return _resolve_reasoning_effort(payload)


def _thinking_disabled(payload: dict[str, Any], model_instance: Any | None, effort: str | None) -> bool:
    if _is_thinking_auto(model_instance):
        return False
    if effort in ("minimal", "none"):
        return True
    if model_instance is not None and getattr(model_instance, "_evoflow_thinking_enabled", None) is False:
        return True
    thinking = _resolve_thinking_dict(payload)
    if isinstance(thinking, dict):
        t = str(thinking.get("type") or "").strip().lower()
        if t in ("disabled", "off", "none"):
            return True
    extra = payload.get("extra_body")
    if isinstance(extra, dict):
        et = extra.get("enable_thinking")
        if et is False or str(et).lower() in ("false", "0", "no"):
            return True
    return False


def _thinking_enabled(payload: dict[str, Any], model_instance: Any | None) -> bool:
    if _is_thinking_auto(model_instance):
        return False
    if model_instance is not None and getattr(model_instance, "_evoflow_thinking_enabled", None) is True:
        return True
    thinking = _resolve_thinking_dict(payload)
    if isinstance(thinking, dict):
        t = str(thinking.get("type") or "").strip().lower()
        if t in ("enabled", "on"):
            return True
        if t in ("disabled", "off", "none", "auto"):
            return False
    extra = payload.get("extra_body")
    if isinstance(extra, dict):
        et = extra.get("enable_thinking")
        if et is True or str(et).lower() in ("true", "1", "yes"):
            return True
        if et is False or str(et).lower() in ("false", "0", "no"):
            return False
    if _resolve_reasoning_effort(payload):
        return True
    return False


def _zhipu_reasoning_effort(effort: str | None, model_name: str) -> str | None:
    norm = _normalize_reasoning_effort(effort)
    if not norm:
        return None
    if norm in ("minimal", "none"):
        return norm
    if norm == "xhigh" and "glm" in str(model_name or "").lower():
        return "max"
    return norm


def _apply_dashscope_thinking_payload(payload: dict[str, Any], *, model_instance: Any | None) -> dict[str, Any]:
    """DashScope / 百炼: ``enable_thinking`` + optional ``thinking_budget``."""
    effort = _runtime_effort(payload, model_instance)
    extra = dict(payload.get("extra_body") or {})
    disabled = _thinking_disabled(payload, model_instance, effort)
    enabled = _thinking_enabled(payload, model_instance) and not disabled

    if enabled:
        extra["enable_thinking"] = True
        if effort and effort not in ("minimal", "none"):
            extra["thinking_budget"] = _EFFORT_THINKING_BUDGET.get(effort, _EFFORT_THINKING_BUDGET["medium"])
    else:
        extra["enable_thinking"] = False
        extra.pop("thinking_budget", None)
        extra.pop("thinkingBudget", None)

    for key in ("thinking", "reasoning"):
        extra.pop(key, None)
    payload.pop("reasoning_effort", None)
    payload.pop("thinking", None)
    payload.pop("reasoning", None)
    if extra:
        payload["extra_body"] = extra
    else:
        payload.pop("extra_body", None)
    return payload


def _apply_zhipu_thinking_payload(
    payload: dict[str, Any],
    *,
    model_instance: Any | None,
) -> dict[str, Any]:
    """智谱 OpenAI 兼容: ``extra_body.thinking`` + ``extra_body.reasoning_effort``."""
    effort = _runtime_effort(payload, model_instance)
    model_name = str(
        getattr(model_instance, "model_name", None)
        or getattr(model_instance, "model", None)
        or payload.get("model")
        or ""
    )
    disabled = _thinking_disabled(payload, model_instance, effort)
    enabled = _thinking_enabled(payload, model_instance) and not disabled

    vendor: dict[str, Any] = {}
    if disabled or not enabled:
        vendor["thinking"] = {"type": "disabled"}
    else:
        vendor["thinking"] = {"type": "enabled"}
        mapped = _zhipu_reasoning_effort(effort, model_name)
        if mapped and mapped not in ("minimal", "none"):
            vendor["reasoning_effort"] = mapped
    vendor.pop("reasoning", None)
    vendor.pop("enable_thinking", None)
    vendor.pop("thinking_budget", None)
    _merge_vendor_extra_body(payload, vendor)
    return payload


def _apply_openai_compat_thinking_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Move LangChain ``model_kwargs`` thinking/reasoning into ``extra_body`` for OpenAI SDK."""
    vendor: dict[str, Any] = {}
    if "thinking" in payload:
        vendor["thinking"] = payload.get("thinking")
    reasoning = payload.get("reasoning")
    if isinstance(reasoning, dict):
        vendor["reasoning"] = reasoning
    thinking = vendor.get("thinking")
    # Anthropic adaptive thinking enum: adaptive | enabled | disabled (not session ``auto``)
    if isinstance(thinking, dict) and str(thinking.get("type") or "").strip().lower() == "auto":
        vendor["thinking"] = {**thinking, "type": "adaptive"}
    if vendor:
        _merge_vendor_extra_body(payload, vendor)
    return payload


def apply_vendor_thinking_request_payload(
    payload: dict[str, Any],
    *,
    base_url: str | None,
    model_instance: Any | None = None,
) -> dict[str, Any]:
    """Apply vendor-native thinking parameters to the outgoing chat payload."""
    kind = _host(base_url)
    if kind == "volc":
        return apply_volcengine_request_payload(payload, base_url=base_url)
    if kind == "dashscope":
        if not (_thinking_enabled(payload, model_instance) or _thinking_disabled(payload, model_instance, _runtime_effort(payload, model_instance))):
            return _apply_openai_compat_thinking_payload(payload)
        return _apply_dashscope_thinking_payload(payload, model_instance=model_instance)
    if kind == "zhipu":
        if not (_thinking_enabled(payload, model_instance) or _thinking_disabled(payload, model_instance, _runtime_effort(payload, model_instance))):
            return _apply_openai_compat_thinking_payload(payload)
        return _apply_zhipu_thinking_payload(payload, model_instance=model_instance)
    return _apply_openai_compat_thinking_payload(payload)
