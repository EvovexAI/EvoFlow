"""Volc Coding Plan catalog + adapter coexistence with Agent Plan."""

from __future__ import annotations

from evoflow.plans.adapters import get_adapter
from evoflow.plans.catalog import get_catalog_entry, list_catalog_entries
from evoflow.plans.volc_agent_plan_models import AGENT_PLAN_CHAT_MODELS, PLAN_CODING_BASE
from evoflow.plans.volc_coding_plan_models import (
    CODING_CONNECTION_KEY,
    CODING_PLAN_CHAT_MODELS,
    chat_models_for_tier,
)


def test_catalog_includes_coding_plan_alongside_agent():
    ids = {e["id"] for e in list_catalog_entries()}
    assert "volcengine.agent_plan" in ids
    assert "volcengine.coding_plan" in ids


def test_coding_plan_catalog_shape():
    entry = get_catalog_entry("volcengine.coding_plan")
    assert entry["plan_family"] == "coding_plan"
    assert entry["endpoints"]["chat"]["base_url"] == PLAN_CODING_BASE
    assert entry["key_rules"]["prefix"] == "ark-"
    tier_ids = {t["id"] for t in entry["tiers"]}
    assert tier_ids == {"lite", "pro"}
    assert "chat" in entry["entitlements"]
    assert "image" not in entry["entitlements"]


def test_coding_plan_models_omit_glm_54_until_official():
    """Agent Plan 已有 glm-5.4；Coding Plan 官方概览尚未列入。"""
    coding_ids = {m["id"] for m in CODING_PLAN_CHAT_MODELS}
    agent_ids = {m["id"] for m in AGENT_PLAN_CHAT_MODELS}
    assert "glm-5.4" in agent_ids
    assert "glm-5.4" not in coding_ids
    assert "glm-5.3" in coding_ids
    assert "ark-code-latest" in coding_ids


def test_coding_plan_kimi_k3_requires_pro():
    lite = {m["id"] for m in chat_models_for_tier("lite")}
    pro = {m["id"] for m in chat_models_for_tier("pro")}
    assert "kimi-k3" not in lite
    assert "kimi-k3" in pro


def test_coding_plan_adapter_registered():
    ad = get_adapter("volcengine", "coding_plan")
    assert ad.vendor == "volcengine"
    assert "coding_plan" in ad.families
    ad.validate_key("ark-test-key", "coding_plan")


def test_coding_plan_materialize_uses_separate_connection(monkeypatch):
    upserts: list[dict] = []
    models: list[dict] = []

    def _upsert_conn(payload):
        upserts.append(payload)
        return payload

    class _Repo:
        @staticmethod
        def list_models():
            return list(models)

        @staticmethod
        def upsert_model(doc):
            models[:] = [r for r in models if r.get("name") != doc.get("name")]
            models.append(doc)

        @staticmethod
        def get_app_setting(_k):
            return "already-set"

        @staticmethod
        def set_app_setting(_k, _v):
            raise AssertionError("Coding Plan must not steal primary when already set")

    monkeypatch.setattr(
        "evoflow.plans.adapters.volc_coding_plan.upsert_model_connection",
        _upsert_conn,
    )
    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.list_models",
        _Repo.list_models,
    )
    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.upsert_model",
        _Repo.upsert_model,
    )
    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.get_app_setting",
        _Repo.get_app_setting,
    )
    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.set_app_setting",
        _Repo.set_app_setting,
    )
    monkeypatch.setattr(
        "evoflow.config.app_config.reload_models_from_db",
        lambda: None,
    )

    catalog = get_catalog_entry("volcengine.coding_plan")
    adapter = get_adapter("volcengine", "coding_plan")
    out = adapter.materialize(
        {
            "id": "b1",
            "api_key": "ark-coding-key",
            "tier_id": "pro",
            "bound_capabilities": ["chat"],
            "display_name": "Coding",
        },
        catalog,
    )
    assert upserts and upserts[0]["key"] == CODING_CONNECTION_KEY
    assert upserts[0]["base_url"] == PLAN_CODING_BASE
    assert out["materialized"]["chat_model_count"] > 0
    assert all(str(m.get("name") or "").startswith("coding-") for m in models)
    assert all(m.get("plan_type") == "volcengine_coding" for m in models)
    assert all("/api/coding/" in str(m.get("base_url") or "") for m in models)


def test_agent_plan_includes_glm_54():
    row = next(m for m in AGENT_PLAN_CHAT_MODELS if m["id"] == "glm-5.4")
    assert row["context_window"] == 1024000
    assert row["max_output"] == 128000
    assert row["min_tier"] == "small"
