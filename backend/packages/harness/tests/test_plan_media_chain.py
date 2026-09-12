"""Agent Plan → media credentials → skill env → config_helpers chain."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.persistence.media_settings import (
    apply_media_credentials_to_mapping,
    patch_media_credentials,
)
from evoflow.persistence.db import reset_db_for_tests
from evoflow.utils.subprocess_platform import sanitize_child_process_env


@pytest.fixture()
def media_db(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "plan-media.db"))
    reset_db_for_tests()
    yield
    reset_db_for_tests()


def test_media_env_injects_seedream_and_seedance_vars(media_db):
    patch_media_credentials(
        {
            "volcengineApiKey": "ark-test-key-abcdefghijklmnopqrstuvwxyz",
            "volcengineArkBaseUrl": "https://ark.cn-beijing.volces.com/api/plan/v3",
            "jimengImageModel": "doubao-seedream-5.0-lite",
            "jimengVideoModel": "doubao-seedance-1.5-pro",
            "enabledVendors": {"volcengine": True},
        }
    )
    env: dict[str, str] = {}
    apply_media_credentials_to_mapping(env)
    assert env["VOLCENGINE_API_KEY"] == "ark-test-key-abcdefghijklmnopqrstuvwxyz"
    assert env["ARK_API_KEY"] == "ark-test-key-abcdefghijklmnopqrstuvwxyz"
    assert env["ARK_SEEDREAM_MODEL"] == "doubao-seedream-5.0-lite"
    assert env["ARK_MODEL"] == "doubao-seedream-5.0-lite"
    assert env["JIMENG_VIDEO_MODEL"] == "doubao-seedance-1.5-pro"
    assert env["SEEDANCE_MODEL"] == "doubao-seedance-1.5-pro"
    assert env["ARK_SEEDREAM_API_BASE_URL"].endswith("/api/plan/v3")


def test_sanitize_child_env_preserves_volcengine_keys(media_db):
    patch_media_credentials(
        {
            "volcengineApiKey": "ark-test-key-abcdefghijklmnopqrstuvwxyz",
            "volcengineArkBaseUrl": "https://ark.cn-beijing.volces.com/api/plan/v3",
            "jimengImageModel": "doubao-seedream-5.0-lite",
            "enabledVendors": {"volcengine": True},
        }
    )
    env = {
        "OPENAI_API_KEY": "sk-should-go",
        "VOLCENGINE_API_KEY": "stale-should-refresh",
        "PATH": "/usr/bin",
    }
    sanitize_child_process_env(env)
    assert "OPENAI_API_KEY" not in env
    assert env["VOLCENGINE_API_KEY"] == "ark-test-key-abcdefghijklmnopqrstuvwxyz"
    assert env["ARK_SEEDREAM_MODEL"] == "doubao-seedream-5.0-lite"


def test_config_helpers_prefers_plan_route(media_db, monkeypatch):
    from evoflow.community.media_generation import config_helpers as ch
    from evoflow.plans.service import create_binding

    monkeypatch.setattr("evoflow.config.app_config.reload_models_from_db", lambda: None)
    monkeypatch.setattr(
        "evoflow.plans.volc_agent_plan_models.fetch_remote_model_ids",
        lambda *a, **k: None,
    )
    create_binding(
        {
            "catalog_id": "volcengine.agent_plan",
            "api_key": "ark-test-key-abcdefghijklmnopqrstuvwxyz",
            "tier_id": "large",
        }
    )
    assert ch.jimeng_image_model() == "doubao-seedream-5.0-lite"
    assert ch.jimeng_video_model() == "doubao-seedance-2.0"
    assert ch.volcengine_api_key().startswith("ark-")
    assert ch.volcengine_ark_base().endswith("/api/plan/v3")
