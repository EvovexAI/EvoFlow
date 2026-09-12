"""Plan Bundle P0: catalog, binding materialize, tier gating."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from evoflow.persistence.db import reset_db_for_tests
from evoflow.plans.catalog import get_catalog_entry, list_catalog_entries, tier_allows_capability
from evoflow.plans.errors import PlanError, PlanErrorCode
from evoflow.plans.resolver import assert_vendor_plan_allows, resolve_capability
from evoflow.plans.service import create_binding, delete_binding, list_bindings


@pytest.fixture()
def plan_db(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "plan-bundle.db"))
    reset_db_for_tests()
    yield
    reset_db_for_tests()


def test_catalog_has_volc_agent_plan():
    items = list_catalog_entries()
    assert any(x["id"] == "volcengine.agent_plan" for x in items)
    entry = get_catalog_entry("volcengine.agent_plan")
    assert tier_allows_capability(entry, "medium", "video")
    assert not tier_allows_capability(entry, "small", "video")
    chat_url = str((entry.get("endpoints") or {}).get("chat", {}).get("base_url") or "")
    assert chat_url.endswith("/api/plan/v3")
    assert "/api/v3" not in chat_url.replace("/api/plan/v3", "")
    assert any(m.get("id") == "kimi-k3" for m in (entry.get("chat_models") or []))
    video = next(c for c in (entry.get("capabilities") or []) if c.get("id") == "video")
    by_id = {str(i.get("id")): i for i in (video.get("items") or [])}
    assert by_id["doubao-seedance-1.5-pro"]["min_tier"] == "medium"
    assert by_id["doubao-seedance-2.0"]["min_tier"] == "large"


def test_create_binding_materialize_and_gate_video(plan_db, monkeypatch):
    monkeypatch.setattr(
        "evoflow.config.app_config.reload_models_from_db",
        lambda: None,
    )
    monkeypatch.setattr(
        "evoflow.plans.volc_agent_plan_models.fetch_remote_model_ids",
        lambda *a, **k: None,
    )

    written = {"conn": None, "media": None}

    def _upsert(raw):
        written["conn"] = raw
        return {"key": raw["key"], "base_url": raw["base_url"], "api_key": "***", "api_type": raw["api_type"]}

    def _patch(patch):
        written["media"] = patch
        return patch

    monkeypatch.setattr(
        "evoflow.plans.adapters.volc_agent_plan.upsert_model_connection",
        _upsert,
    )
    monkeypatch.setattr(
        "evoflow.plans.adapters.volc_agent_plan.patch_media_credentials",
        _patch,
    )

    binding = create_binding(
        {
            "catalog_id": "volcengine.agent_plan",
            "api_key": "ark-test-key-abcdefghijklmnopqrstuvwxyz",
            "tier_id": "small",
        }
    )
    assert binding["status"] == "active"
    assert binding["vendor"] == "volcengine"
    assert "video" not in binding["bound_capabilities"]
    assert "image" in binding["bound_capabilities"]
    assert written["conn"]["key"] == "volcengine"
    assert written["conn"]["base_url"].endswith("/api/plan/v3")
    assert written["media"]["volcengineArkBaseUrl"].endswith("/api/plan/v3")
    assert written["media"]["volcengineSpeechApiKey"].startswith("ark-")
    assert written["media"]["jimengImageModel"] == "doubao-seedream-5.0-lite"
    assert "jimengVideoModel" not in written["media"]
    assert written["media"]["enabledVendors"]["volcengine"] is True
    assert int(binding["materialized"]["chat_model_count"]) >= 10
    assert binding["materialized"]["chat_models_source"] == "catalog"

    from evoflow.persistence import config_repositories as cfg_repo

    ids = {str(r.get("model") or "") for r in cfg_repo.list_models()}
    assert "doubao-seed-2.0-lite" in ids
    assert "glm-5.3" in ids
    assert "kimi-k3" not in ids
    assert "doubao-embedding-vision" in ids
    lite_row = next(r for r in cfg_repo.list_models() if str(r.get("model")) == "doubao-seed-2.0-lite")
    assert lite_row.get("plan_type") == "volcengine_agent"
    assert (lite_row.get("plan_config") or {}).get("tier_id") == "small"
    assert (lite_row.get("plan_config") or {}).get("min_tier") == "small"
    assert int(binding["materialized"].get("embedding_model_count") or 0) >= 1
    assert binding["materialized"].get("web_search") is True
    assert binding["materialized"].get("web_search_preferred_doubao") is True
    from evoflow.persistence.web_search_settings import get_preferred_backend, get_web_search_settings

    assert get_preferred_backend() == "doubao"
    assert get_web_search_settings().get("preferredBackendSource") == "agent_plan"
    assert str(cfg_repo.get_app_setting("primary_model") or "")

    with pytest.raises(PlanError) as ei:
        assert_vendor_plan_allows("video", vendor="volcengine", plan_family="agent_plan")
    assert ei.value.code == PlanErrorCode.CAPABILITY_NOT_IN_TIER

    route = resolve_capability("image", vendor="volcengine", allow_missing=False)
    assert route is not None
    assert route["source"] == "plan"
    assert "ark-" in str(route.get("api_key") or "")
    assert route.get("model_hint") == "doubao-seedream-5.0-lite"

    assert list_bindings()
    delete_binding(binding["id"])
    assert not list_bindings()


def test_wrong_key_rejected(plan_db):
    with pytest.raises(PlanError) as ei:
        create_binding(
            {
                "catalog_id": "volcengine.agent_plan",
                "api_key": "sk-not-ark",
                "tier_id": "medium",
            }
        )
    assert ei.value.code == PlanErrorCode.WRONG_KEY_TYPE


def test_agent_plan_chat_models_tier_and_remote_merge(monkeypatch):
    from evoflow.plans.volc_agent_plan_models import (
        PLAN_CHAT_BASE,
        chat_models_for_tier,
        is_agent_plan_openai_base,
        openai_compat_fallback_models,
        resolve_chat_models,
    )

    monkeypatch.setattr(
        "evoflow.plans.volc_agent_plan_models.fetch_remote_model_ids",
        lambda *a, **k: None,
    )
    small_ids = {m["id"] for m in chat_models_for_tier("small")}
    medium_ids = {m["id"] for m in chat_models_for_tier("medium")}
    assert "doubao-seed-2.0-lite" in small_ids
    assert "ark-code-latest" in small_ids
    assert "auto" not in small_ids
    assert "kimi-k3" not in small_ids
    assert "kimi-k3" in medium_ids
    assert is_agent_plan_openai_base(PLAN_CHAT_BASE)
    assert not is_agent_plan_openai_base("https://ark.cn-beijing.volces.com/api/v3")
    fb = openai_compat_fallback_models(PLAN_CHAT_BASE, tier_id="small")
    assert fb and any(x["id"] == "glm-5.3" for x in fb)

    models, source = resolve_chat_models("ark-x", tier_id="small", base_url=PLAN_CHAT_BASE)
    assert source == "catalog"
    assert models


def test_create_binding_medium_includes_kimi_k3(plan_db, monkeypatch):
    monkeypatch.setattr("evoflow.config.app_config.reload_models_from_db", lambda: None)
    monkeypatch.setattr(
        "evoflow.plans.volc_agent_plan_models.fetch_remote_model_ids",
        lambda *a, **k: ["kimi-k3", "glm-5.3", "ep-ignore-me"],
    )
    monkeypatch.setattr(
        "evoflow.plans.adapters.volc_agent_plan.upsert_model_connection",
        lambda raw: {"key": raw["key"], "base_url": raw["base_url"], "api_key": "***", "api_type": raw["api_type"]},
    )
    monkeypatch.setattr(
        "evoflow.plans.adapters.volc_agent_plan.patch_media_credentials",
        lambda patch: patch,
    )
    binding = create_binding(
        {
            "catalog_id": "volcengine.agent_plan",
            "api_key": "ark-test-key-abcdefghijklmnopqrstuvwxyz",
            "tier_id": "medium",
        }
    )
    assert binding["materialized"]["chat_models_source"] == "remote"
    from evoflow.persistence import config_repositories as cfg_repo

    ids = {str(r.get("model") or "") for r in cfg_repo.list_models()}
    assert "kimi-k3" in ids
    assert "glm-5.3" in ids
    assert "ep-ignore-me" not in ids


def test_create_binding_medium_sets_seedance_15_pro(plan_db, monkeypatch):
    monkeypatch.setattr("evoflow.config.app_config.reload_models_from_db", lambda: None)
    monkeypatch.setattr(
        "evoflow.plans.volc_agent_plan_models.fetch_remote_model_ids",
        lambda *a, **k: None,
    )
    written: dict[str, Any] = {}

    def _patch(patch):
        written["media"] = patch
        return patch

    monkeypatch.setattr(
        "evoflow.plans.adapters.volc_agent_plan.upsert_model_connection",
        lambda raw: {"key": raw["key"], "base_url": raw["base_url"], "api_key": "***", "api_type": raw["api_type"]},
    )
    monkeypatch.setattr(
        "evoflow.plans.adapters.volc_agent_plan.patch_media_credentials",
        _patch,
    )
    binding = create_binding(
        {
            "catalog_id": "volcengine.agent_plan",
            "api_key": "ark-test-key-abcdefghijklmnopqrstuvwxyz",
            "tier_id": "medium",
        }
    )
    assert "video" in binding["bound_capabilities"]
    assert written["media"]["jimengImageModel"] == "doubao-seedream-5.0-lite"
    assert written["media"]["jimengVideoModel"] == "doubao-seedance-1.5-pro"
    assert binding["materialized"]["video_model"] == "doubao-seedance-1.5-pro"

    route = resolve_capability("video", vendor="volcengine", allow_missing=False)
    assert route is not None
    assert route.get("model_hint") == "doubao-seedance-1.5-pro"


def test_default_media_models_for_tier():
    from evoflow.plans.volc_agent_plan_models import default_media_models_for_tier

    small = default_media_models_for_tier("small")
    assert small["image"] == "doubao-seedream-5.0-lite"
    assert small["video"] is None

    medium = default_media_models_for_tier("medium")
    assert medium["video"] == "doubao-seedance-1.5-pro"

    large = default_media_models_for_tier("large")
    assert large["video"] == "doubao-seedance-2.0"
