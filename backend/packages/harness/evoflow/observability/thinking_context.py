"""Thinking / reasoning observability: runtime context, vendor inference, stored request parsing."""

from __future__ import annotations

import json
from typing import Any

# Mirrors ``factory._VOLC_THINKING_BUDGET_BY_EFFORT`` for reverse lookup in observability.
_BUDGET_BY_EFFORT: dict[str, int] = {
    "minimal": 4096,
    "low": 8192,
    "medium": 16384,
    "high": 32768,
    "xhigh": 49152,
}
_EFFORT_BY_BUDGET: list[tuple[int, str]] = sorted(
    ((budget, effort) for effort, budget in _BUDGET_BY_EFFORT.items()),
    key=lambda item: item[0],
)


def _normalize_reasoning_effort(value: Any) -> str | None:
    from evoflow.models.factory import _normalize_reasoning_effort

    return _normalize_reasoning_effort(value)


def _bool_or_none(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    s = str(value).strip().lower()
    if s in ("1", "true", "yes", "on"):
        return True
    if s in ("0", "false", "no", "off"):
        return False
    return None


def _configurable_for_log() -> dict[str, Any]:
    try:
        from langgraph.config import get_config

        cfg = get_config()
        c = cfg.get("configurable") if isinstance(cfg, dict) else {}
        return dict(c) if isinstance(c, dict) else {}
    except Exception:
        return {}


def thinking_context_from_configurable(configurable: dict[str, Any] | None) -> dict[str, Any]:
    """Runtime thinking selection from LangGraph ``configurable``."""
    c = configurable if isinstance(configurable, dict) else {}
    thinking_type = str(c.get("thinking_type") or "").strip().lower() or None
    reasoning_effort = _normalize_reasoning_effort(c.get("reasoning_effort"))
    te = c.get("thinking_enabled")
    thinking_enabled: bool | None
    if te is None:
        if thinking_type == "manual" and reasoning_effort in ("minimal", "none"):
            thinking_enabled = False
        elif thinking_type == "manual" and reasoning_effort:
            thinking_enabled = True
        else:
            thinking_enabled = None
    else:
        thinking_enabled = _bool_or_none(te)
    session_mode = str(c.get("session_mode") or "").strip() or None
    out: dict[str, Any] = {
        "source": "runtime",
        "thinking_enabled": thinking_enabled,
        "reasoning_effort": reasoning_effort,
        "thinking_type": thinking_type,
        "session_mode": session_mode,
    }
    return {k: v for k, v in out.items() if v is not None}


def thinking_context_from_model(model: Any | None) -> dict[str, Any]:
    """Resolved thinking on the chat model instance (set in ``create_chat_model``)."""
    if model is None:
        return {}
    out: dict[str, Any] = {"source": "model_instance"}
    te = getattr(model, "_evoflow_thinking_enabled", None)
    if te is not None:
        out["thinking_enabled"] = _bool_or_none(te)
    reff = _normalize_reasoning_effort(getattr(model, "_evoflow_reasoning_effort", None))
    if reff:
        out["reasoning_effort"] = reff
    tt = str(getattr(model, "_evoflow_thinking_type", "") or "").strip().lower() or None
    if tt:
        out["thinking_type"] = tt
    sm = str(getattr(model, "_evoflow_session_mode", "") or "").strip() or None
    if sm:
        out["session_mode"] = sm
    return {k: v for k, v in out.items() if k is not None}


def collect_runtime_thinking_context(model: Any | None = None) -> dict[str, Any]:
    """Merge configurable + model-instance thinking context for observability."""
    runtime = thinking_context_from_configurable(_configurable_for_log())
    inst = thinking_context_from_model(model)
    merged: dict[str, Any] = {"source": "runtime"}
    for key in ("thinking_enabled", "reasoning_effort", "thinking_type", "session_mode"):
        if key in inst:
            merged[key] = inst[key]
        elif key in runtime:
            merged[key] = runtime[key]
    if inst:
        merged["model_instance"] = inst
    if runtime:
        merged["configurable"] = runtime
    return merged


def effort_from_budget_tokens(budget: int | None) -> str | None:
    if budget is None or budget <= 0:
        return None
    best: str | None = None
    best_dist = 10**12
    for ref_budget, effort in _EFFORT_BY_BUDGET:
        dist = abs(int(budget) - ref_budget)
        if dist < best_dist:
            best_dist = dist
            best = effort
    return best


def infer_thinking_from_vendor_payload(payload: dict[str, Any] | None) -> dict[str, Any]:
    """Infer vendor-side thinking parameters from the final HTTP payload."""
    if not isinstance(payload, dict):
        return {}
    out: dict[str, Any] = {"source": "vendor_payload"}
    reasoning_effort = _normalize_reasoning_effort(payload.get("reasoning_effort"))
    reasoning = payload.get("reasoning")
    if isinstance(reasoning, dict):
        reasoning_effort = reasoning_effort or _normalize_reasoning_effort(reasoning.get("effort"))
    if reasoning_effort:
        out["reasoning_effort"] = reasoning_effort
        if reasoning_effort in ("minimal", "none"):
            out["thinking_enabled"] = False
        else:
            out["thinking_enabled"] = True

    extra = payload.get("extra_body")
    if isinstance(extra, dict):
        et = extra.get("enable_thinking")
        if et is True or str(et).lower() in ("true", "1", "yes"):
            out["thinking_enabled"] = True
        elif et is False or str(et).lower() in ("false", "0", "no"):
            out["thinking_enabled"] = False
        budget_raw = extra.get("thinking_budget") or extra.get("thinkingBudget")
        if budget_raw is not None and "reasoning_effort" not in out:
            try:
                budget = int(budget_raw)
            except (TypeError, ValueError):
                budget = None
            if budget is not None and budget > 0:
                out["thinking_budget_tokens"] = budget
                inferred = effort_from_budget_tokens(budget)
                if inferred:
                    out["reasoning_effort_inferred"] = inferred

        thinking = extra.get("thinking")
        if isinstance(thinking, dict):
            typ = str(thinking.get("type") or "").strip().lower()
            if typ in ("enabled", "auto", "on"):
                out["thinking_enabled"] = True
            elif typ in ("disabled", "off", "none"):
                out["thinking_enabled"] = False
            if "reasoning_effort" not in out:
                nested_reasoning = extra.get("reasoning")
                if isinstance(nested_reasoning, dict):
                    inferred_effort = _normalize_reasoning_effort(nested_reasoning.get("effort"))
                    if inferred_effort:
                        out["reasoning_effort"] = inferred_effort
                flat_effort = _normalize_reasoning_effort(extra.get("reasoning_effort"))
                if flat_effort:
                    out["reasoning_effort"] = flat_effort
            budget_raw = thinking.get("budget_tokens") or thinking.get("budgetTokens")
            try:
                budget = int(budget_raw) if budget_raw is not None else None
            except (TypeError, ValueError):
                budget = None
            if budget is not None and budget > 0:
                if "reasoning_effort" not in out:
                    out["thinking_budget_tokens"] = budget
                    inferred = effort_from_budget_tokens(budget)
                    if inferred:
                        out["reasoning_effort_inferred"] = inferred
        elif thinking is True:
            out["thinking_enabled"] = True
        elif thinking is False:
            out["thinking_enabled"] = False

    top_thinking = payload.get("thinking")
    if isinstance(top_thinking, dict):
        typ = str(top_thinking.get("type") or "").strip().lower()
        if typ in ("enabled", "auto", "on"):
            out["thinking_enabled"] = True
        elif typ in ("disabled", "off", "none"):
            out["thinking_enabled"] = False
        budget_raw = top_thinking.get("budget_tokens") or top_thinking.get("budgetTokens")
        try:
            budget = int(budget_raw) if budget_raw is not None else None
        except (TypeError, ValueError):
            budget = None
        if budget is not None and budget > 0:
            if "reasoning_effort" not in out:
                out["thinking_budget_tokens"] = budget
                inferred = effort_from_budget_tokens(budget)
                if inferred:
                    out["reasoning_effort_inferred"] = inferred

    return {k: v for k, v in out.items() if v is not None}


def merge_thinking_context(
    runtime: dict[str, Any] | None,
    vendor: dict[str, Any] | None,
) -> dict[str, Any]:
    """Unified view: runtime wins for effort/type; vendor supplies budget + inferred effort."""
    rt = dict(runtime or {})
    vd = dict(vendor or {})
    merged: dict[str, Any] = {}
    for key in ("thinking_enabled", "reasoning_effort", "thinking_type", "session_mode"):
        if key in rt:
            merged[key] = rt[key]
        elif key in vd:
            merged[key] = vd[key]
    if "thinking_budget_tokens" in vd:
        merged["thinking_budget_tokens"] = vd["thinking_budget_tokens"]
    if "reasoning_effort_inferred" in vd and "reasoning_effort" not in merged:
        merged["reasoning_effort_inferred"] = vd["reasoning_effort_inferred"]
    if rt:
        merged["runtime"] = rt
    if vd:
        merged["vendor"] = vd
    return merged


def thinking_fields_for_sqlite(merged: dict[str, Any] | None) -> dict[str, Any]:
    """Map merged thinking context to SQLite column values."""
    m = merged if isinstance(merged, dict) else {}
    te = m.get("thinking_enabled")
    thinking_enabled: int | None
    if te is None:
        thinking_enabled = None
    else:
        thinking_enabled = 1 if _bool_or_none(te) else 0
    reasoning_effort = _normalize_reasoning_effort(m.get("reasoning_effort"))
    if not reasoning_effort:
        reasoning_effort = _normalize_reasoning_effort(m.get("reasoning_effort_inferred"))
    thinking_type = str(m.get("thinking_type") or "").strip().lower() or None
    session_mode = str(m.get("session_mode") or "").strip() or None
    budget_raw = m.get("thinking_budget_tokens")
    try:
        thinking_budget_tokens = int(budget_raw) if budget_raw is not None else None
    except (TypeError, ValueError):
        thinking_budget_tokens = None
    return {
        "thinking_enabled": thinking_enabled,
        "reasoning_effort": reasoning_effort,
        "thinking_type": thinking_type,
        "thinking_budget_tokens": thinking_budget_tokens,
        "session_mode": session_mode,
    }


def parse_request_json_obj(req_raw: str | dict[str, Any] | None) -> dict[str, Any] | None:
    if req_raw is None:
        return None
    if isinstance(req_raw, dict):
        return req_raw
    try:
        obj = json.loads(req_raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    return obj if isinstance(obj, dict) else None


def resolve_vendor_request_from_stored(obj: dict[str, Any] | None) -> dict[str, Any] | None:
    """Return the vendor HTTP request body from stored ``request_json``.

    New rows store the vendor body at the top level. Legacy rows may wrap it in
    ``vendor_request`` or only include a truncated ``payload`` preview.
    """
    if not isinstance(obj, dict):
        return None
    vendor = obj.get("vendor_request")
    if isinstance(vendor, dict):
        return vendor
    if obj.get("messages") is not None or obj.get("model") is not None:
        return obj
    payload = obj.get("payload")
    if isinstance(payload, dict) and (
        payload.get("messages") is not None or payload.get("model") is not None
    ):
        return payload
    return None


def extract_thinking_from_stored_request(
    req_raw: str | dict[str, Any] | None,
    *,
    row: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Read thinking context from DB columns and/or stored ``request_json``."""
    merged: dict[str, Any] = {}
    if isinstance(row, dict):
        if row.get("thinking_enabled") is not None:
            merged["thinking_enabled"] = bool(int(row["thinking_enabled"]))
        for key in ("reasoning_effort", "thinking_type", "session_mode"):
            val = row.get(key)
            if val:
                merged[key] = str(val)
        if row.get("thinking_budget_tokens") is not None:
            try:
                merged["thinking_budget_tokens"] = int(row["thinking_budget_tokens"])
            except (TypeError, ValueError):
                pass

    obj = parse_request_json_obj(req_raw)
    if isinstance(obj, dict):
        eth = obj.get("evoflow_thinking")
        if isinstance(eth, dict):
            for key in (
                "thinking_enabled",
                "reasoning_effort",
                "reasoning_effort_inferred",
                "thinking_type",
                "thinking_budget_tokens",
                "session_mode",
            ):
                if key in eth and key not in merged:
                    merged[key] = eth[key]
        vendor = resolve_vendor_request_from_stored(obj)
        if isinstance(vendor, dict):
            inferred = infer_thinking_from_vendor_payload(vendor)
            for key, val in inferred.items():
                if key == "source":
                    continue
                if key not in merged:
                    merged[key] = val

    if "reasoning_effort" not in merged and merged.get("reasoning_effort_inferred"):
        merged["reasoning_effort"] = merged["reasoning_effort_inferred"]
    return merged


def format_thinking_label(ctx: dict[str, Any] | None) -> str:
    """Human-readable label for UI (zh-friendly)."""
    m = ctx if isinstance(ctx, dict) else {}
    te = m.get("thinking_enabled")
    effort = _normalize_reasoning_effort(m.get("reasoning_effort")) or _normalize_reasoning_effort(
        m.get("reasoning_effort_inferred")
    )
    thinking_type = str(m.get("thinking_type") or "").strip().lower()
    budget = m.get("thinking_budget_tokens")

    if te is False or effort in ("minimal", "none"):
        return "关闭"
    if thinking_type == "auto" and te is None and not effort:
        return "自动"
    if effort:
        labels = {
            "minimal": "极低",
            "low": "轻度",
            "medium": "中度",
            "high": "深度",
            "xhigh": "极高",
            "max": "最高",
        }
        label = labels.get(effort, effort)
        if budget and not m.get("reasoning_effort"):
            return f"{label} ({budget} tokens)"
        return label
    if te is True:
        if budget:
            return f"开启 ({budget} tokens)"
        return "开启"
    if te is None:
        return "未知"
    return "关闭"
