"""Aliyun Coding Plan catalog + adapter coexistence with Token Plan."""

from __future__ import annotations

from evoflow.plans.adapters import get_adapter
from evoflow.plans.aliyun_coding_plan_models import (
    CODING_CONNECTION_KEY,
    CODING_PLAN_CHAT_MODELS,
    PLAN_CHAT_BASE,
)
from evoflow.plans.catalog import get_catalog_entry, list_catalog_entries


def test_catalog_includes_aliyun_coding_plan():
    ids = {e["id"] for e in list_catalog_entries()}
    assert "aliyun.token_plan" in ids
    assert "aliyun.coding_plan" in ids
    assert "volcengine.coding_plan" in ids


def test_aliyun_coding_plan_catalog_shape():
    entry = get_catalog_entry("aliyun.coding_plan")
    assert entry["plan_family"] == "coding_plan"
    assert entry["endpoints"]["chat"]["base_url"] == PLAN_CHAT_BASE
    assert entry["key_rules"]["prefix"] == "sk-sp-"
    assert "chat" in entry["entitlements"]
    assert "image" not in entry["entitlements"]
    assert entry["ui"].get("hide_tiers") is True


def test_aliyun_coding_plan_official_model_ids():
    ids = {m["id"] for m in CODING_PLAN_CHAT_MODELS}
    assert ids == {
        "qwen3.7-plus",
        "qwen3.6-plus",
        "kimi-k2.5",
        "glm-5",
        "MiniMax-M2.5",
        "qwen3.5-plus",
    }
    # 与 Token Plan / 火山 Agent 的 glm-5.4 不是同一产品线
    assert "glm-5.4" not in ids


def test_aliyun_coding_plan_adapter_registered():
    ad = get_adapter("aliyun", "coding_plan")
    assert ad.vendor == "aliyun"
    ad.validate_key("sk-sp-test-key", "coding_plan")


def test_aliyun_coding_plan_materialize_separate_connection(monkeypatch):
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
            raise AssertionError("must not steal primary")

    monkeypatch.setattr(
        "evoflow.plans.adapters.aliyun_coding_plan.upsert_model_connection",
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

    catalog = get_catalog_entry("aliyun.coding_plan")
    adapter = get_adapter("aliyun", "coding_plan")
    out = adapter.materialize(
        {
            "id": "ac1",
            "api_key": "sk-sp-coding-key",
            "tier_id": "pro",
            "bound_capabilities": ["chat"],
            "display_name": "Aliyun Coding",
        },
        catalog,
    )
    assert upserts and upserts[0]["key"] == CODING_CONNECTION_KEY
    assert upserts[0]["base_url"] == PLAN_CHAT_BASE
    assert out["materialized"]["chat_model_count"] == len(CODING_PLAN_CHAT_MODELS)
    assert all(str(m.get("name") or "").startswith("coding-") for m in models)
    assert all(m.get("plan_type") == "aliyun_coding" for m in models)
    assert all("coding.dashscope" in str(m.get("base_url") or "") for m in models)
