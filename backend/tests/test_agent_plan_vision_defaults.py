"""Agent Plan catalog defaults: DeepSeek V4.1 / Auto vision flags."""

from __future__ import annotations

from evoflow.plans.volc_agent_plan_models import (
    AGENT_PLAN_CHAT_MODELS,
    sync_agent_plan_vision_from_catalog,
)


def _by_id() -> dict[str, dict]:
    return {str(m["id"]): m for m in AGENT_PLAN_CHAT_MODELS}


def test_deepseek_v41_flash_supports_vision_by_default():
    catalog = _by_id()
    assert catalog["deepseek-v4.1-flash"]["vision"] is True
    assert catalog["deepseek-v4.1-flash-economy"]["vision"] is True
    assert catalog["ark-code-latest"]["vision"] is True
    # Legacy V4 Flash remains text-only on Ark Agent Plan.
    assert catalog["deepseek-v4-flash"]["vision"] is False


def test_sync_agent_plan_vision_heals_stale_rows(monkeypatch):
    rows = [
        {
            "name": "deepseek-v4.1-flash",
            "vendor": "volcengine",
            "model": "deepseek-v4.1-flash",
            "base_url": "https://ark.cn-beijing.volces.com/api/plan/v3",
            "plan_type": "volcengine_agent",
            "supports_vision": False,
            "api_key": "ark-test",
        },
        {
            "name": "deepseek-v4-flash",
            "vendor": "volcengine",
            "model": "deepseek-v4-flash",
            "base_url": "https://ark.cn-beijing.volces.com/api/plan/v3",
            "plan_type": "volcengine_agent",
            "supports_vision": False,
            "api_key": "ark-test",
        },
    ]
    upserts: list[dict] = []

    class _Repo:
        @staticmethod
        def list_models():
            return list(rows)

        @staticmethod
        def upsert_model(doc):
            upserts.append(doc)
            for i, r in enumerate(rows):
                if r["name"] == doc["name"]:
                    rows[i] = doc
                    break

    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.list_models",
        _Repo.list_models,
    )
    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.upsert_model",
        _Repo.upsert_model,
    )

    fixed = sync_agent_plan_vision_from_catalog()
    assert fixed == 1
    assert upserts[0]["model"] == "deepseek-v4.1-flash"
    assert upserts[0]["supports_vision"] is True
    # Second call is a no-op once healed.
    assert sync_agent_plan_vision_from_catalog() == 0
