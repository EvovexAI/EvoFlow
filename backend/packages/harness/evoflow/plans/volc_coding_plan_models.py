"""Volcengine Ark Coding Plan chat models.

Official chat Base URL is ``/api/coding/v3`` (not Agent Plan ``/api/plan/v3``).
Coding Plan can coexist with Agent Plan (separate binding / connection / model rows).

Source: https://www.volcengine.com/docs/82379/2098574 (套餐概览)
        https://www.volcengine.com/docs/82379/2098573 (快速开始)
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.plans.volc_agent_plan_models import (
    PLAN_CODING_BASE,
    VENDOR_KEY,
    is_chat_model_id,
)

logger = logging.getLogger(__name__)

CODING_CONNECTION_KEY = "volcengine-coding"
CODING_PLAN_TYPE = "volcengine_coding"
CODING_CATALOG_ID = "volcengine.coding_plan"

_TIER_RANK = {"lite": 0, "pro": 1}

# 对齐 Coding Plan 套餐概览（2026-11-24）。官方尚未把 glm-5.4 列入 Coding Plan
# （glm-5.4 目前在 Agent Plan 2026-11-23 上线公告中）。
CODING_PLAN_CHAT_MODELS: list[dict[str, Any]] = [
    {
        "id": "ark-code-latest",
        "label": "Auto（ark-code-latest）",
        "context_window": 256000,
        "max_output": 128000,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
        "preferred_primary": True,
        "notes": "控制台切换目标模型；配置文件写 ark-code-latest",
    },
    {
        "id": "doubao-seed-2.0-mini",
        "label": "Doubao Seed 2.0 Mini",
        "context_window": 256000,
        "max_output": 128000,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "极速；简单编码 / 补全",
    },
    {
        "id": "doubao-seed-2.1-lite",
        "label": "Doubao Seed 2.1 Lite",
        "context_window": 1024000,
        "max_output": 256000,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "日常编码",
    },
    {
        "id": "doubao-seed-2.1-pro",
        "label": "Doubao Seed 2.1 Pro",
        "context_window": 1024000,
        "max_output": 256000,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "复杂推理 / 长链路",
    },
    {
        "id": "doubao-seed-evolving",
        "label": "Doubao Seed Evolving",
        "context_window": 1024000,
        "max_output": 256000,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "周级升级统一 ID",
    },
    {
        "id": "glm-5.3-flash",
        "label": "GLM 5.3 Flash",
        "context_window": 1024000,
        "max_output": 128000,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "原生多模态，支持图片输入",
    },
    {
        "id": "glm-5.3",
        "label": "GLM 5.3",
        "context_window": 1024000,
        "max_output": 128000,
        "vision": False,
        "reasoning": True,
        "min_tier": "lite",
        "thinking_always_on": True,
        "notes": "glm-latest；默认开启思考；抵扣系数较高",
    },
    {
        "id": "kimi-k2.8-preview",
        "label": "Kimi K2.8 Preview",
        "context_window": 1024000,
        "max_output": 1024000,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
    },
    {
        "id": "deepseek-v4-flash",
        "label": "DeepSeek V4 Flash",
        "context_window": 1024000,
        "max_output": 384000,
        "vision": False,
        "reasoning": True,
        "min_tier": "lite",
    },
    {
        "id": "deepseek-v4-pro",
        "label": "DeepSeek V4 Pro",
        "context_window": 1024000,
        "max_output": 384000,
        "vision": False,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "正式版；抵扣系数较高",
    },
    {
        "id": "kimi-k3",
        "label": "Kimi K3",
        "context_window": 1024000,
        "max_output": 128000,
        "vision": True,
        "reasoning": True,
        "min_tier": "pro",
        "thinking_always_on": True,
        "notes": "即将下线；抵扣高，仅建议 Pro；默认开启思考",
    },
    {
        "id": "kimi-k3.1-pro",
        "label": "Kimi K3.1 Pro",
        "context_window": 1024000,
        "max_output": 1024000,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
    },
    {
        "id": "deepseek-v4.1-flash",
        "label": "DeepSeek V4.1 Flash",
        "context_window": 1024000,
        "max_output": 384000,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "原生多模态",
    },
    {
        "id": "deepseek-v4.1-flash-economy",
        "label": "DeepSeek V4.1 Flash Economy",
        "context_window": 1024000,
        "max_output": 384000,
        "vision": True,
        "reasoning": True,
        "min_tier": "lite",
        "notes": "与标准版同权重，更便宜、略慢",
    },
]

CODING_PLAN_CAPABILITIES: list[dict[str, Any]] = [
    {
        "id": "chat",
        "label": "对话 / Coding 模型",
        "summary": (
            "写入「对话模型」页（独立 connection：volcengine-coding）；"
            "官方约定额度主要在编程工具内抵扣，通用 API 可能被判滥用。"
        ),
        "item_source": "chat_models",
        "min_tier": "lite",
    },
]


def chat_models_for_tier(tier_id: str | None) -> list[dict[str, Any]]:
    rank = _TIER_RANK.get(str(tier_id or "pro").strip().lower(), 1)
    out: list[dict[str, Any]] = []
    for row in CODING_PLAN_CHAT_MODELS:
        min_rank = _TIER_RANK.get(str(row.get("min_tier") or "lite").lower(), 0)
        if rank >= min_rank:
            out.append(dict(row))
    return out


def _config_name(model_id: str) -> str:
    # 与 Agent Plan 行隔离：同 model id 不覆盖 /api/plan/v3 那一套
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
    context = int(spec.get("context_window") or 256000)
    max_out = int(spec.get("max_output") or 128000)
    always_on = bool(spec.get("thinking_always_on"))
    notes = str(spec.get("notes") or "").strip()
    desc = "方舟 Coding Plan"
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
        doc["when_thinking_enabled"] = {"extra_body": {"thinking": {"type": "enabled"}}}
        doc["thinking"] = {
            "supported_levels": ["low", "medium", "high"],
            "default_level": "medium",
            "default_mode": "enabled" if always_on else "auto",
        }
    return doc


def upsert_coding_plan_chat_models(
    *,
    api_key: str,
    base_url: str = PLAN_CODING_BASE,
    tier_id: str | None,
    binding_id: str | None = None,
    set_primary_if_missing: bool = False,
) -> dict[str, Any]:
    """Write Coding Plan chat models. Does not overwrite Agent Plan rows."""
    from evoflow.persistence import config_repositories as cfg_repo

    models = chat_models_for_tier(tier_id)
    names: list[str] = []
    preferred: str | None = None
    for spec in models:
        model_id = str(spec.get("id") or "").strip()
        if not model_id or not is_chat_model_id(model_id):
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
