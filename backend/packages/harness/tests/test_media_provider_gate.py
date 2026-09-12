"""Verify unconfigured media providers are rejected at resolve and tool entry."""

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from evoflow.community.media_generation import config_helpers as ch
from evoflow.community.media_generation.tools import (
    media_image_generate_tool,
    media_video_generate_tool,
)

_EVOFLOW_ROOT = Path(__file__).resolve().parents[4]


@pytest.fixture(autouse=True)
def _clear_media_env(monkeypatch):
    monkeypatch.setenv("EVOFLOW_CONFIG_PATH", str(_EVOFLOW_ROOT / "config.yaml"))
    for key in (
        "VOLCENGINE_API_KEY",
        "ARK_API_KEY",
        "DASHSCOPE_API_KEY",
        "KLING_ACCESS_KEY_ID",
        "KLING_ACCESS_KEY_SECRET",
        "KLING_API_KEY",
        "VOLCENGINE_TTS_APPID",
        "VOLCENGINE_TTS_ACCESS_TOKEN",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(ch, "ensure_media_credentials", lambda: None)


def test_resolve_rejects_unconfigured_explicit_provider():
    _, err = ch.resolve_image_provider("wan")
    assert err is not None
    assert "未配置" in err or "停用" in err

    _, err = ch.resolve_video_provider("kling")
    assert err is not None
    assert "未配置" in err or "停用" in err


def test_resolve_uses_only_configured_default(monkeypatch):
    monkeypatch.setenv("VOLCENGINE_API_KEY", "test-ark-key")
    prov, err = ch.resolve_image_provider(None)
    assert err is None
    assert prov == "jimeng"


def test_configured_providers_lists_only_with_keys(monkeypatch):
    monkeypatch.setenv("VOLCENGINE_API_KEY", "test-ark-key")
    assert ch.configured_image_providers() == ["jimeng"]
    assert ch.available_media_providers() == {
        "image": ["jimeng"],
        "video": ["jimeng"],
        "voice": [],
    }


def test_configured_providers_respects_enabled_flag(monkeypatch):
    monkeypatch.setenv("VOLCENGINE_API_KEY", "test-ark-key")
    monkeypatch.setattr(
        "evoflow.persistence.media_settings.cfg_repo.get_app_setting",
        lambda key: {
            "media.credentials": {
                "volcengineApiKey": "test-ark-key",
                "enabledVendors": {"volcengine": False},
            }
        }.get(key),
    )
    assert ch.configured_image_providers() == []


def test_media_image_generate_rejects_wan_without_key():
    runtime = MagicMock()
    raw = media_image_generate_tool.func(
        runtime,
        prompt="cat",
        provider="wan",
        mode="text2image",
        reference_image_urls=None,
        aspect_ratio="16:9",
        max_wait_seconds=300,
    )
    data = json.loads(raw)
    assert data["ok"] is False
    assert "未配置" in data["message"] or "停用" in data["message"]


def test_media_video_generate_rejects_kling_without_key():
    runtime = MagicMock()
    raw = media_video_generate_tool.func(
        runtime,
        prompt="cat",
        provider="kling",
        mode="text2video",
        first_frame_url=None,
        audio_url=None,
        duration=5,
        aspect_ratio="16:9",
        generate_audio=None,
    )
    data = json.loads(raw)
    assert data["ok"] is False
    assert "未配置" in data["message"] or "停用" in data["message"]


def test_disabled_kling_rejected_even_with_env_keys(monkeypatch):
    monkeypatch.setenv("KLING_ACCESS_KEY_ID", "ak-test")
    monkeypatch.setenv("KLING_ACCESS_KEY_SECRET", "sk-test")
    monkeypatch.setattr(
        "evoflow.persistence.media_settings.cfg_repo.get_app_setting",
        lambda key: {
            "media.credentials": {
                "klingAccessKeyId": "ak-test",
                "klingAccessKeySecret": "sk-test",
                "enabledVendors": {"kling": False, "volcengine": True},
            }
        }.get(key),
    )
    from evoflow.persistence.media_settings import apply_media_credentials_to_environ

    apply_media_credentials_to_environ()
    assert not ch.is_kling_configured()

    _, err = ch.resolve_image_provider("kling")
    assert err is not None
    assert "停用" in err


def test_media_image_generate_rejects_disabled_kling(monkeypatch):
    monkeypatch.setenv("KLING_ACCESS_KEY_ID", "ak-test")
    monkeypatch.setenv("KLING_ACCESS_KEY_SECRET", "sk-test")
    monkeypatch.setattr(
        "evoflow.persistence.media_settings.cfg_repo.get_app_setting",
        lambda key: {
            "media.credentials": {
                "enabledVendors": {"kling": False, "volcengine": True},
            }
        }.get(key),
    )
    monkeypatch.setattr(ch, "ensure_media_credentials", ch.ensure_media_credentials)

    runtime = MagicMock()
    raw = media_image_generate_tool.func(
        runtime,
        prompt="cat",
        provider="kling",
        mode="text2image",
        reference_image_urls=None,
        aspect_ratio="16:9",
        max_wait_seconds=300,
    )
    data = json.loads(raw)
    assert data["ok"] is False
    assert "停用" in data["message"]
    assert "KLING_ACCESS_KEY" not in data["message"]


def test_volcengine_ark_base_defaults_to_plan_v3(monkeypatch):
    monkeypatch.delenv("VOLCENGINE_ARK_BASE_URL", raising=False)
    monkeypatch.setattr(ch, "ensure_media_credentials", lambda: None)
    assert ch.volcengine_ark_base() == "https://ark.cn-beijing.volces.com/api/plan/v3"


def test_volcengine_ark_base_rewrites_legacy_api_v3(monkeypatch):
    monkeypatch.setenv("VOLCENGINE_ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")
    monkeypatch.setattr(ch, "ensure_media_credentials", lambda: None)
    assert ch.volcengine_ark_base() == "https://ark.cn-beijing.volces.com/api/plan/v3"
