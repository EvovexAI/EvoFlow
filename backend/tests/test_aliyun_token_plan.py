"""Aliyun Bailian Token Plan catalog + adapter smoke tests."""

from __future__ import annotations

import pytest

from evoflow.plans.adapters import get_adapter
from evoflow.plans.aliyun_token_plan_models import (
    PLAN_CHAT_BASE,
    chat_models_for_tier,
    default_media_models_for_tier,
    is_token_plan_openai_base,
    openai_compat_fallback_models,
)
from evoflow.plans.catalog import get_catalog_entry, list_catalog_entries, tier_entitlements
from evoflow.plans.errors import PlanError, PlanErrorCode


def test_catalog_includes_aliyun_token_plan():
    ids = {e["id"] for e in list_catalog_entries()}
    assert "aliyun.token_plan" in ids
    assert "volcengine.agent_plan" in ids


def test_aliyun_token_plan_catalog_shape():
    entry = get_catalog_entry("aliyun.token_plan")
    assert entry["vendor"] == "aliyun"
    assert entry["plan_family"] == "token_plan"
    assert entry["endpoints"]["chat"]["base_url"] == PLAN_CHAT_BASE
    assert entry["key_rules"]["prefix"] == "sk-sp-"
    tier_ids = {t["id"] for t in entry["tiers"]}
    assert tier_ids == {"lite", "essential", "standard", "pro"}
    ents = tier_entitlements(entry, "essential")
    assert "chat" in ents
    assert "image" in ents
    assert "video" in ents
    assert "web_search" in ents


def test_chat_models_and_media_defaults():
    models = chat_models_for_tier("essential")
    ids = {m["id"] for m in models}
    assert "auto" in ids
    assert "qwen3.8-max" in ids
    assert "deepseek-v4.1-flash" in ids
    assert "wan2.7-image" not in ids
    media = default_media_models_for_tier("essential")
    assert media["image"]
    assert media["video"]


def test_openai_compat_fallback():
    assert is_token_plan_openai_base(PLAN_CHAT_BASE)
    assert not is_token_plan_openai_base("https://dashscope.aliyuncs.com/compatible-mode/v1")
    fb = openai_compat_fallback_models(PLAN_CHAT_BASE)
    assert fb and any(row["id"] == "auto" for row in fb)


def test_adapter_key_validation():
    adapter = get_adapter("aliyun", "token_plan")
    adapter.validate_key("sk-sp-test-key", "token_plan")
    with pytest.raises(PlanError) as ei:
        adapter.validate_key("sk-plain-payg", "token_plan")
    assert ei.value.code == PlanErrorCode.WRONG_KEY_TYPE
    with pytest.raises(PlanError) as ei2:
        adapter.validate_key("ark-xxx", "token_plan")
    assert ei2.value.code == PlanErrorCode.WRONG_KEY_TYPE


def test_adapter_build_route():
    adapter = get_adapter("aliyun", "token_plan")
    catalog = get_catalog_entry("aliyun.token_plan")
    binding = {
        "id": "b1",
        "api_key": "sk-sp-test",
        "tier_id": "essential",
        "bound_capabilities": ["chat", "image", "video"],
    }
    route = adapter.build_route(binding, catalog, "chat")
    assert route["base_url"] == PLAN_CHAT_BASE
    assert route["api_key"] == "sk-sp-test"
    assert route["meter_tags"]["plan_family"] == "token_plan"
    img = adapter.build_route(binding, catalog, "image")
    assert "token-plan" in img["base_url"]
    assert img["model_hint"]
