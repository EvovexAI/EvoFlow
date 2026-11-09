"""Builtin Plan catalog (hot-updatable JSON files optional later)."""

from __future__ import annotations

import copy
from typing import Any

from evoflow.plans.errors import PlanError, PlanErrorCode
from evoflow.plans.aliyun_token_plan_models import (
    PLAN_ANTHROPIC_BASE as ALIYUN_PLAN_ANTHROPIC_BASE,
    PLAN_CHAT_BASE as ALIYUN_PLAN_CHAT_BASE,
    PLAN_MEDIA_BASE as ALIYUN_PLAN_MEDIA_BASE,
    TOKEN_PLAN_CAPABILITIES,
    TOKEN_PLAN_CHAT_MODELS,
)
from evoflow.plans.volc_agent_plan_models import (
    AGENT_PLAN_CAPABILITIES,
    AGENT_PLAN_CHAT_MODELS,
    PLAN_CHAT_BASE,
    PLAN_CODING_BASE,
    PLAN_MEDIA_BASE,
)

# Builtin Plan catalogs. Endpoint notes follow current vendor docs; Catalog is SSOT for UI.
_BUILTIN: list[dict[str, Any]] = [
    {
        "schema": 1,
        "id": "volcengine.agent_plan",
        "vendor": "volcengine",
        "plan_family": "agent_plan",
        "name": "火山方舟 Agent Plan",
        "description": (
            "胜任 Coding，不止 Coding。支持 DeepSeek-V4.1-Flash、Kimi-K3.1-Pro、"
            "Doubao-Seed-2.1、GLM-5.3 / Flash、Seedance 2.5 等；全模态 + Harness。"
            "价格与额度以控制台为准。"
        ),
        "subscribe_url": "https://www.volcengine.com/product/ark",
        "invite_code": "",
        "docs_url": "https://www.volcengine.com/docs/82379/2366394?lang=zh",
        "promo_hint": (
            "套餐概览同步于 2026-11-08：已移除 MiniMax-M3 / Kimi-K2.7-Code；"
            "Kimi-K3.1-Pro 最大输出 1024k；DeepSeek-V4.1-Flash 权重 261101"
        ),
        "models_hint": [
            "DeepSeek-V4.1-Flash",
            "Kimi-K3.1-Pro",
            "Doubao-Seed-2.1",
            "GLM-5.3",
        ],
        "chat_models": AGENT_PLAN_CHAT_MODELS,
        "capabilities": AGENT_PLAN_CAPABILITIES,
        "entitlements": ["chat", "embedding", "tts", "asr", "image", "web_search"],
        "tiers": [
            {
                "id": "small",
                "label": "Small",
                "price_hint": "¥40/月 · 20,000 AFP",
                "entitlements": ["chat", "embedding", "tts", "asr", "image", "web_search"],
                "limits_hint": {
                    "afp_month": 20000,
                    "afp_week": 7000,
                    "afp_5h": 2000,
                    "video": False,
                },
            },
            {
                "id": "medium",
                "label": "Medium",
                "price_hint": "¥200/月 · 100,000 AFP",
                # 官方：Small/Medium 轻量化体验，不含视频生成
                "entitlements": [
                    "chat",
                    "embedding",
                    "tts",
                    "asr",
                    "image",
                    "web_search",
                ],
                "limits_hint": {
                    "afp_month": 100000,
                    "afp_week": 35000,
                    "afp_5h": 10000,
                    "video": False,
                },
            },
            {
                "id": "large",
                "label": "Large",
                "price_hint": "¥500/月 · 250,000 AFP",
                "entitlements": [
                    "chat",
                    "embedding",
                    "tts",
                    "asr",
                    "image",
                    "video",
                    "web_search",
                ],
                "limits_hint": {
                    "afp_month": 250000,
                    "afp_week": 87500,
                    "afp_5h": 25000,
                    "video": True,
                },
            },
            {
                "id": "max",
                "label": "Max",
                "price_hint": "¥1000/月 · 500,000 AFP",
                "entitlements": [
                    "chat",
                    "embedding",
                    "tts",
                    "asr",
                    "image",
                    "video",
                    "web_search",
                ],
                "limits_hint": {
                    "afp_month": 500000,
                    "afp_week": 175000,
                    "afp_5h": 50000,
                    "video": True,
                },
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
                "notes": ("Agent Plan 向量仅 doubao-embedding-vision；POST {base}/embeddings/multimodal（纯文本 doubao-embedding 不支持 Agent Plan）"),
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
    {
        "schema": 1,
        "id": "aliyun.token_plan",
        "vendor": "aliyun",
        "plan_family": "token_plan",
        "name": "阿里云百炼 Token Plan",
        "description": (
            "Credits 统一计量；千问 / DeepSeek / GLM / 万相 / HappyHorse 等；"
            "内置联网搜索与代码解释器。个人版 Lite→Pro（以控制台为准）。"
        ),
        "subscribe_url": "https://bailian.console.aliyun.com/",
        "invite_code": "",
        "docs_url": "https://help.aliyun.com/zh/model-studio/token-plan-personal-overview",
        "promo_hint": "套餐专属 Key 以 sk-sp- 开头；聊天用 compatible-mode/v1，勿用按量 DashScope 地址",
        "models_hint": [
            "auto",
            "qwen3.8-max",
            "qwen3.8-flash",
            "deepseek-v4.1-flash",
            "glm-5.3",
        ],
        "chat_models": TOKEN_PLAN_CHAT_MODELS,
        "capabilities": TOKEN_PLAN_CAPABILITIES,
        "entitlements": ["chat", "tts", "asr", "image", "video", "web_search"],
        "tiers": [
            {
                "id": "lite",
                "label": "Lite",
                "price_hint": "¥39/月（新用户限时约 ¥19.5）",
                "entitlements": ["chat", "tts", "asr", "image", "video", "web_search"],
                "limits_hint": {"credits_month": 11500, "harness": False},
            },
            {
                "id": "essential",
                "label": "Essential",
                "price_hint": "¥79/月（新用户限时约 ¥39.5）",
                "entitlements": ["chat", "tts", "asr", "image", "video", "web_search"],
                "limits_hint": {"credits_month": 25500, "harness": False},
            },
            {
                "id": "standard",
                "label": "Standard",
                "price_hint": "¥139/月",
                "entitlements": ["chat", "tts", "asr", "image", "video", "web_search"],
                "limits_hint": {"credits_month": 45000, "harness": True},
            },
            {
                "id": "pro",
                "label": "Pro",
                "price_hint": "¥499/月",
                "entitlements": ["chat", "tts", "asr", "image", "video", "web_search"],
                "limits_hint": {"credits_month": 180000, "harness": True},
            },
        ],
        "endpoints": {
            "chat": {
                "base_url": ALIYUN_PLAN_CHAT_BASE,
                "api": "openai-completions",
                "notes": "Token Plan OpenAI-compat; do not use payg dashscope compatible-mode",
            },
            "anthropic": {
                "base_url": ALIYUN_PLAN_ANTHROPIC_BASE,
                "api": "anthropic-messages",
            },
            "image": {
                "base_url": ALIYUN_PLAN_MEDIA_BASE,
                "api": "vendor-native",
            },
            "video": {
                "base_url": ALIYUN_PLAN_MEDIA_BASE,
                "api": "vendor-native",
            },
            "tts": {
                "base_url": ALIYUN_PLAN_MEDIA_BASE,
                "api": "vendor-native",
            },
            "asr": {
                "base_url": ALIYUN_PLAN_MEDIA_BASE,
                "api": "vendor-native",
            },
        },
        "key_rules": {
            "prefix": "sk-sp-",
            "incompatible_with_payg_pool": True,
            "description": "使用 Token Plan 套餐专属 Key（sk-sp- 开头）；勿与按量 sk- Key 混用",
        },
        "quota_hints": {
            "unit": "Credits",
            "windows": ["month"],
            "note": "余额以百炼控制台为准；本地仅为 soft quota 提示",
        },
        "error_signatures": [
            {"match": "订阅已过期", "code": "quota_exhausted"},
            {"match": "额度不足", "code": "quota_exhausted"},
        ],
        # 个人版各档模型表相同，仅 Credits 额度不同；绑定 UI 不展示档位选择。
        "ui": {
            "modes": ["payg", "coding_plan", "agent_or_token_plan"],
            "hide_tiers": True,
        },
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
