"""Aliyun Bailian Coding Plan chat models.

Official OpenAI-compat Base:
``https://coding.dashscope.aliyuncs.com/v1``
Anthropic: ``https://coding.dashscope.aliyuncs.com/apps/anthropic``
Key prefix: ``sk-sp-`` (same prefix as Token Plan, different product / Base).

Coexists with Token Plan via separate binding, connection ``aliyun-coding``,
and model row names ``coding-*``.

Source: https://help.aliyun.com/zh/model-studio/coding-plan
"""

from __future__ import annotations

from typing import Any

VENDOR_KEY = "aliyun"
CODING_CONNECTION_KEY = "aliyun-coding"
CODING_PLAN_TYPE = "aliyun_coding"
CODING_CATALOG_ID = "aliyun.coding_plan"
PLAN_CHAT_BASE = "https://coding.dashscope.aliyuncs.com/v1"
PLAN_ANTHROPIC_BASE = "https://coding.dashscope.aliyuncs.com/apps/anthropic"

_TIER_RANK = {"lite": 0, "pro": 1}
_DEFAULT_CONTEXT = 1_000_000
_DEFAULT_MAX_OUT = 131_072

# 官方「支持的模型」精确版本（2026-11-24 核对）。Lite 已停售但模型表与 Pro 相同。
CODING_PLAN_CHAT_MODELS: list[dict[str, Any]] = [
    {
        "id": "qwen3.7-plus",
        "label": "Qwen 3.7 Plus",
        "context_window": _DEFAULT_CONTEXT,
        "max_output": _DEFAULT_MAX_OUT,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
        "preferred_primary": True,
        "notes": "推荐；支持图片理解",
    },
    {
        "id": "qwen3.6-plus",
        "label": "Qwen 3.6 Plus",
        "context_window": _DEFAULT_CONTEXT,
        "max_output": _DEFAULT_MAX_OUT,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "推荐；支持图片理解",
    },
    {
        "id": "kimi-k2.5",
        "label": "Kimi K2.5",
        "context_window": _DEFAULT_CONTEXT,
        "max_output": _DEFAULT_MAX_OUT,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "推荐；支持图片理解",
    },
    {
        "id": "glm-5",
        "label": "GLM-5",
        "context_window": _DEFAULT_CONTEXT,
        "max_output": _DEFAULT_MAX_OUT,
        "vision": False,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "推荐",
    },
    {
        "id": "MiniMax-M2.5",
        "label": "MiniMax M2.5",
        "context_window": _DEFAULT_CONTEXT,
        "max_output": _DEFAULT_MAX_OUT,
        "vision": False,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "推荐；官方精确 ID 大小写敏感",
    },
    {
        "id": "qwen3.5-plus",
        "label": "Qwen 3.5 Plus",
        "context_window": _DEFAULT_CONTEXT,
        "max_output": _DEFAULT_MAX_OUT,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "更多模型；支持图片理解",
    },
]

CODING_PLAN_CAPABILITIES: list[dict[str, Any]] = [
    {
        "id": "chat",
        "label": "对话 / Coding 模型",
        "summary": (
            "写入「对话模型」页（独立 connection：aliyun-coding）；"
            "官方严禁当普通后端 API 批量调用，额度仅限编程工具场景。"
        ),
        "item_source": "chat_models",
        "min_tier": "lite",
    },
]


def chat_models_for_tier(tier_id: str | None) -> list[dict[str, Any]]:
    # Lite/Pro 模型表相同；默认按 Pro 写全量
    rank = _TIER_RANK.get(str(tier_id or "pro").strip().lower(), 1)
    out: list[dict[str, Any]] = []
    for row in CODING_PLAN_CHAT_MODELS:
        min_rank = _TIER_RANK.get(str(row.get("min_tier") or "lite").lower(), 0)
        if rank >= min_rank:
            out.append(dict(row))
    return out


def _config_name(model_id: str) -> str:
    return f"coding-{model_id}"


def _model_document(
    *,
    name: str,
    spec: dict[str, Any],
    api_key: str,
    base_url: str,
    tier_id: str | None = None,
    binding_id: str | None = None,
) -> dict[str, Any]:
    model_id = str(spec["id"])
    reasoning = bool(spec.get("reasoning", True))
    vision = bool(spec.get("vision"))
    context = int(spec.get("context_window") or _DEFAULT_CONTEXT)
    max_out = int(spec.get("max_output") or _DEFAULT_MAX_OUT)
    notes = str(spec.get("notes") or "").strip()
    desc = "百炼 Coding Plan"
    if notes:
        desc = f"{desc} · {notes}"
    doc: dict[str, Any] = {
        "name": name,
        "vendor": VENDOR_KEY,
        "model": model_id,
        "display_name": str(spec.get("label") or model_id),
        "description": desc,
        "use": "langchain_openai:ChatOpenAI",
        "base_url": base_url,
        "api_key": api_key,
        "supports_thinking": reasoning,
        "supports_reasoning_effort": reasoning,
        "supports_vision": vision,
        "context_length": context,
        "input_context_length": context,
        "output_context_length": max_out,
        "max_tokens": max_out,
        "request_timeout": 600,
        "max_retries": 2,
        "plan_type": CODING_PLAN_TYPE,
        "plan_config": {
            "catalog_id": CODING_CATALOG_ID,
            "tier_id": tier_id,
            "min_tier": str(spec.get("min_tier") or "lite"),
            "capability": "chat",
            "model_id": model_id,
        },
    }
    if binding_id:
        doc["plan_config"]["binding_id"] = binding_id
    if reasoning:
        doc["when_thinking_enabled"] = {"extra_body": {"enable_thinking": True}}
        doc["thinking"] = {
            "supported_levels": ["low", "medium", "high"],
            "default_level": "medium",
            "default_mode": "auto",
        }
    return doc


def upsert_coding_plan_chat_models(
    *,
    api_key: str,
    base_url: str = PLAN_CHAT_BASE,
    tier_id: str | None,
    binding_id: str | None = None,
    set_primary_if_missing: bool = False,
) -> dict[str, Any]:
    """Write Coding Plan chat models. Does not overwrite Token Plan rows."""
    from evoflow.persistence import config_repositories as cfg_repo

    models = chat_models_for_tier(tier_id)
    names: list[str] = []
    preferred: str | None = None
    for spec in models:
        model_id = str(spec.get("id") or "").strip()
        if not model_id:
            continue
        name = _config_name(model_id)
        doc = _model_document(
            name=name,
            spec=spec,
            api_key=api_key,
            base_url=base_url,
            tier_id=tier_id,
            binding_id=binding_id,
        )
        cfg_repo.upsert_model(doc)
        names.append(name)
        if preferred is None and spec.get("preferred_primary"):
            preferred = name

    if set_primary_if_missing and names:
        current = str(cfg_repo.get_app_setting("primary_model") or "").strip()
        if not current:
            cfg_repo.set_app_setting("primary_model", preferred or names[0])

    return {"count": len(names), "source": "catalog", "names": names}
