"""Vendor-native web search injection (DashScope enable_search)."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from evoflow.config.model_config import ModelConfig
from evoflow.models.factory import _apply_native_web_search, _is_dashscope_like_host


def test_is_dashscope_like_host_by_vendor_and_url() -> None:
    assert _is_dashscope_like_host(SimpleNamespace(vendor="aliyun", base_url=""))
    assert _is_dashscope_like_host(
        SimpleNamespace(vendor="", base_url="https://dashscope.aliyuncs.com/compatible-mode/v1")
    )
    assert not _is_dashscope_like_host(
        SimpleNamespace(vendor="openai", base_url="https://api.openai.com/v1")
    )


def test_apply_native_web_search_dashscope_merges_enable_search() -> None:
    model = SimpleNamespace(
        name="kimi-k2.5",
        vendor="aliyun",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        enable_web_search=True,
        web_search_options={"forced_search": True},
    )
    model_settings: dict = {"extra_body": {"enable_thinking": True}}
    kwargs: dict = {}
    _apply_native_web_search(model, model_settings, kwargs)
    assert kwargs["extra_body"]["enable_search"] is True
    assert kwargs["extra_body"]["enable_thinking"] is True
    assert kwargs["extra_body"]["search_options"] == {"forced_search": True}
    assert model_settings["extra_body"]["enable_search"] is True


def test_apply_native_web_search_noop_when_disabled() -> None:
    model = SimpleNamespace(
        name="qwen",
        vendor="aliyun",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        enable_web_search=False,
        web_search_options=None,
    )
    model_settings: dict = {}
    kwargs: dict = {}
    _apply_native_web_search(model, model_settings, kwargs)
    assert "extra_body" not in kwargs
    assert "extra_body" not in model_settings


def test_apply_native_web_search_non_dashscope_ignores(caplog: pytest.LogCaptureFixture) -> None:
    model = SimpleNamespace(
        name="gpt-4o",
        vendor="openai",
        base_url="https://api.openai.com/v1",
        enable_web_search=True,
        web_search_options=None,
    )
    model_settings: dict = {}
    kwargs: dict = {}
    with caplog.at_level("WARNING"):
        _apply_native_web_search(model, model_settings, kwargs)
    assert "extra_body" not in kwargs
    assert "enable_search" not in str(kwargs)
    assert any("enable_web_search" in r.message for r in caplog.records)


def test_model_config_roundtrip_enable_web_search() -> None:
    cfg = ModelConfig.model_validate(
        {
            "name": "aliyun-kimi",
            "use": "langchain_openai:ChatOpenAI",
            "model": "kimi-k2.5",
            "vendor": "aliyun",
            "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "enable_web_search": True,
            "web_search_options": {"forced_search": False},
        }
    )
    assert cfg.enable_web_search is True
    assert cfg.web_search_options == {"forced_search": False}
    dumped = cfg.model_dump(exclude_none=True)
    assert dumped["enable_web_search"] is True
    assert dumped["web_search_options"] == {"forced_search": False}


def test_create_chat_model_injects_enable_search_for_dashscope() -> None:
    from evoflow.models import factory as factory_mod

    model_cfg = ModelConfig.model_validate(
        {
            "name": "dash-qwen",
            "use": "langchain_openai:ChatOpenAI",
            "model": "qwen-plus",
            "vendor": "aliyun",
            "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "api_key": "sk-test",
            "enable_web_search": True,
            "supports_thinking": True,
            "when_thinking_enabled": {"extra_body": {"enable_thinking": True}},
        }
    )
    app_cfg = SimpleNamespace(
        primary_model="dash-qwen",
        models=[model_cfg],
        get_model_config=lambda name: model_cfg if name == "dash-qwen" else None,
    )
    captured: dict = {}

    class FakeChat:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    with (
        patch.object(factory_mod, "get_app_config", return_value=app_cfg),
        patch.object(factory_mod, "resolve_class", return_value=FakeChat),
        patch.object(factory_mod, "patch_chat_model_instance_credentials", lambda m: None),
        patch.object(factory_mod, "sanitize_model_connection_settings", lambda d: None),
        patch.object(factory_mod, "build_pool_from_config", return_value=None),
    ):
        factory_mod.create_chat_model("dash-qwen", thinking_enabled=True)

    eb = captured.get("extra_body") or {}
    assert eb.get("enable_search") is True
    assert eb.get("enable_thinking") is True
    assert "enable_web_search" not in captured
