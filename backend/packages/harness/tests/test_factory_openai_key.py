"""Regression tests for OPENAI_API_KEY fallback scoping in model factory."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from langchain_openai import ChatOpenAI

from evoflow.config.model_config import ModelConfig
from evoflow.models.claude_provider import ClaudeChatModel
from evoflow.models.factory import create_chat_model


def _model_config(use: str) -> ModelConfig:
    return ModelConfig(name="test-model", use=use, model="test")


def _fake_app_config(model_config: ModelConfig) -> SimpleNamespace:
    return SimpleNamespace(
        get_model_config=lambda _name: model_config,
        primary_model=None,
        models=[model_config],
    )


def test_openai_api_key_not_injected_for_claude_model(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-fallback")
    cfg = _model_config("evoflow.models.claude_provider:ClaudeChatModel")
    created: dict = {}

    class _FakeClaude(ClaudeChatModel):
        def __init__(self, **kwargs):
            created.update(kwargs)

    with patch("evoflow.models.factory.get_app_config", return_value=_fake_app_config(cfg)), patch(
        "evoflow.models.factory.resolve_class",
        return_value=_FakeClaude,
    ), patch(
        "evoflow.models.factory.is_tracing_enabled",
        return_value=False,
    ), patch(
        "evoflow.models.factory.patch_chat_model_instance_credentials",
    ):
        create_chat_model("test-model")

    assert "api_key" not in created


def test_openai_api_key_injected_for_chat_openai(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-fallback")
    cfg = _model_config("langchain_openai:ChatOpenAI")
    created: dict = {}

    class _FakeOpenAI(ChatOpenAI):
        def __init__(self, **kwargs):
            created.update(kwargs)

    with patch("evoflow.models.factory.get_app_config", return_value=_fake_app_config(cfg)), patch(
        "evoflow.models.factory.resolve_class",
        return_value=_FakeOpenAI,
    ), patch(
        "evoflow.models.factory.is_tracing_enabled",
        return_value=False,
    ), patch(
        "evoflow.models.factory.patch_chat_model_instance_credentials",
    ):
        create_chat_model("test-model")

    assert created.get("api_key") == "sk-openai-fallback"


def test_context_length_not_passed_to_chat_openai(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-fallback")
    cfg = ModelConfig(
        name="test-model",
        use="langchain_openai:ChatOpenAI",
        model="deepseek-v4-flash",
        context_length=256_000,
        input_context_length=64_000,
        output_context_length=8_192,
        max_tokens=256_000,
    )
    created: dict = {}

    class _FakeOpenAI(ChatOpenAI):
        def __init__(self, **kwargs):
            created.update(kwargs)

    with patch("evoflow.models.factory.get_app_config", return_value=_fake_app_config(cfg)), patch(
        "evoflow.models.factory.resolve_class",
        return_value=_FakeOpenAI,
    ), patch(
        "evoflow.models.factory.is_tracing_enabled",
        return_value=False,
    ), patch(
        "evoflow.models.factory.patch_chat_model_instance_credentials",
    ):
        create_chat_model("test-model")

    assert "context_length" not in created
    assert "input_context_length" not in created
    assert "output_context_length" not in created
    assert created.get("max_tokens") == 65536


def test_plan_metadata_not_passed_to_chat_openai(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-fallback")
    cfg = ModelConfig(
        name="deepseek-v4-flash",
        use="langchain_openai:ChatOpenAI",
        model="deepseek-v4-flash",
        plan_type="volcengine_agent",
        plan_config={"tier_id": "small", "binding_id": "bind-1"},
    )
    created: dict = {}

    class _FakeOpenAI(ChatOpenAI):
        def __init__(self, **kwargs):
            created.update(kwargs)

    with patch("evoflow.models.factory.get_app_config", return_value=_fake_app_config(cfg)), patch(
        "evoflow.models.factory.resolve_class",
        return_value=_FakeOpenAI,
    ), patch(
        "evoflow.models.factory.is_tracing_enabled",
        return_value=False,
    ), patch(
        "evoflow.models.factory.patch_chat_model_instance_credentials",
    ):
        create_chat_model("deepseek-v4-flash")

    assert "plan_type" not in created
    assert "plan_config" not in created
