"""Builtin Plan catalog (hot-updatable JSON files optional later)."""

from __future__ import annotations

import copy
from typing import Any

from evoflow.plans.errors import PlanError, PlanErrorCode
from evoflow.plans.volc_agent_plan_models import (
    AGENT_PLAN_CAPABILITIES,
    AGENT_PLAN_CHAT_MODELS,
    PLAN_CHAT_BASE,
    PLAN_CODING_BASE,
    PLAN_MEDIA_BASE,
)

# P0: Volcano Agent Plan. Endpoint notes follow current Ark docs; Catalog is SSOT for UI.
_BUILTIN: list[dict[str, Any]] = [
    {
        "schema": 1,
        "id": "volcengine.agent_plan",
        "vendor": "volcengine",
        "plan_family": "agent_plan",
        "name": "火山方舟 Agent Plan",
        "description": (
            "胜任 Coding，不止 Coding。最新支持 DeepSeek-V4-flash 正式版、Kimi-K3、"
            "Doubao-Seed-Evolving、GLM-5.3 等；全模态模型与 Harness。"
            "Small/Medium 可叠加优惠低至约 ¥9.4 起（以活动页为准）。"
        ),
        "subscribe_url": "https://www.volcengine.com/product/ark",
        "invite_code": "",
        "docs_url": "https://www.volcengine.com/docs/82379/2366394?lang=zh",
        "promo_hint": "详见火山方舟官方产品页与活动说明",
        "models_hint": [
            "DeepSeek-V4-flash",
            "Kimi-K3",
            "Doubao-Seed-Evolving",
            "GLM-5.3",
        ],
        "chat_models": AGENT_PLAN_CHAT_MODELS,
        "capabilities": AGENT_PLAN_CAPABILITIES,
        "entitlements": ["chat", "embedding", "tts", "asr", "image", "web_search"],
        "tiers": [
            {
                "id": "small",
                "label": "Small",
                "price_hint": "低至 ¥9.4/月起",
                "entitlements": ["chat", "embedding", "tts", "asr", "image", "web_search"],
                "limits_hint": {"afp_month": 20000, "video": False},
            },
            {
                "id": "medium",
                "label": "Medium",
                "price_hint": "优惠价见活动页",
                "entitlements": [
                    "chat",
                    "embedding",
                    "tts",
                    "asr",
                    "image",
                    "video",
                    "web_search",
                ],
                "limits_hint": {"afp_month": 100000, "video": True},
            },
            {
                "id": "large",
                "label": "Large",
                "price_hint": "¥500/月",
                "entitlements": [
                    "chat",
                    "embedding",
                    "tts",
                    "asr",
                    "image",
                    "video",
                    "web_search",
                ],
                "limits_hint": {"afp_month": 250000, "video": True},
            },
            {
                "id": "max",
                "label": "Max",
                "price_hint": "¥1000/月",
                "entitlements": [
                    "chat",
                    "embedding",
                    "tts",
                    "asr",
                    "image",
                    "video",
                    "web_search",
                ],
                "limits_hint": {"afp_month": 500000, "video": True},
            },
        ],
        "endpoints": {
            "chat": {
                "base_url": PLAN_CHAT_BASE,
                "api": "openai-completions",
                "notes": "Agent Plan OpenAI-compat; do not use payg /api/v3",
            },
            "coding": {
                "base_url": PLAN_CODING_BASE,
                "api": "openai-completions",
            },
            "image": {
                "base_url": PLAN_MEDIA_BASE,
                "api": "vendor-native",
            },
            "video": {
                "base_url": PLAN_MEDIA_BASE,
                "api": "vendor-native",
            },
            "tts": {
                "base_url": "https://ark.cn-beijing.volces.com",
                "api": "vendor-native",
                "notes": "Plan TTS path owned by VolcAgentPlanAdapter / volcengine_speech",
            },
            "asr": {
                "base_url": "https://ark.cn-beijing.volces.com",
                "api": "vendor-native",
            },
            "embedding": {
                "base_url": PLAN_CHAT_BASE,
                "api": "openai-completions",
                "notes": (
                    "Agent Plan 向量仅 doubao-embedding-vision；"
                    "POST {base}/embeddings/multimodal（纯文本 doubao-embedding 不支持 Agent Plan）"
                ),
            },
        },
        "key_rules": {
            "prefix": "ark-",
            "incompatible_with_payg_pool": True,
            "description": "使用方舟 Agent Plan 专属 Key（ark- 开头）；勿与按量 Key 混用轮询",
        },
        "quota_hints": {
            "unit": "AFP",
            "windows": ["5h", "week", "month"],
            "note": "余额以火山控制台为准；本地仅为 soft quota 提示",
        },
        "error_signatures": [
            {
                "match": "Agent Plan deduction is not enabled",
                "code": "deduct_not_enabled",
            },
            {"match": "未开通 Agent Plan", "code": "deduct_not_enabled"},
        ],
        "ui": {"modes": ["payg", "coding_plan", "agent_or_token_plan"]},
    },
]


def list_catalog_entries() -> list[dict[str, Any]]:
    return [copy.deepcopy(e) for e in _BUILTIN]


def get_catalog_entry(catalog_id: str) -> dict[str, Any]:
    cid = str(catalog_id or "").strip()
    for entry in _BUILTIN:
        if entry["id"] == cid:
            return copy.deepcopy(entry)
    raise PlanError(
        PlanErrorCode.CATALOG_NOT_FOUND,
        f"未知套餐目录：{cid}",
        details={"catalog_id": cid},
    )


def tier_entitlements(entry: dict[str, Any], tier_id: str | None) -> list[str]:
    """Resolve capability list for a tier (falls back to family entitlements)."""
    base = [str(x) for x in (entry.get("entitlements") or [])]
    tid = str(tier_id or "").strip().lower()
    if not tid:
        return base
    for tier in entry.get("tiers") or []:
        if str(tier.get("id") or "").strip().lower() == tid:
            ents = tier.get("entitlements")
            if isinstance(ents, list) and ents:
                return [str(x) for x in ents]
            return base
    return base


def tier_allows_capability(entry: dict[str, Any], tier_id: str | None, capability: str) -> bool:
    return capability in tier_entitlements(entry, tier_id)
