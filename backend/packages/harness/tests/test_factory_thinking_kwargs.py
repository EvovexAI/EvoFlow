"""Ensure UI thinking metadata never leaks as top-level OpenAI SDK kwargs."""

from __future__ import annotations

from types import SimpleNamespace

from evoflow.models.factory import (
    _apply_vendor_auto_thinking,
    _effective_when_thinking_enabled,
    _nest_openai_compat_thinking_kwargs,
    _sanitize_anthropic_style_thinking_settings,
)
from evoflow.models.vendor_thinking_payload import apply_vendor_thinking_request_payload
from langchain_openai import ChatOpenAI


def test_effective_when_thinking_enabled_excludes_ui_metadata() -> None:
    model = SimpleNamespace(
        when_thinking_enabled={"extra_body": {"thinking": {"type": "enabled"}}},
        thinking={
            "default_mode": "auto",
            "supported_levels": ["low", "medium", "high"],
            "default_level": "medium",
        },
    )
    out = _effective_when_thinking_enabled(model)
    assert out["extra_body"]["thinking"] == {"type": "enabled"}
    assert "thinking" not in out


def test_effective_when_thinking_enabled_merges_vendor_thinking_fields() -> None:
    model = SimpleNamespace(
        when_thinking_enabled={"thinking": {"type": "enabled"}},
        thinking={"type": "enabled", "budget_tokens": 8192, "default_level": "low"},
    )
    out = _effective_when_thinking_enabled(model)
    assert out["thinking"] == {"type": "enabled", "budget_tokens": 8192}


def test_nest_openai_compat_moves_top_level_thinking_to_extra_body() -> None:
    kwargs = {"model": "glm-5.2", "thinking": {"type": "enabled"}}
    _nest_openai_compat_thinking_kwargs(ChatOpenAI, kwargs)
    assert "thinking" not in kwargs
    assert kwargs["extra_body"]["thinking"] == {"type": "enabled"}


def test_generic_gateway_payload_strips_top_level_thinking() -> None:
    payload = {
        "model": "some-model",
        "thinking": {"default_mode": "auto", "default_level": "medium"},
    }
    out = apply_vendor_thinking_request_payload(payload, base_url="https://api.example.com/v1")
    assert "thinking" not in out
    assert out["extra_body"]["thinking"] == {"default_mode": "auto", "default_level": "medium"}


def test_openai_compat_rewrites_thinking_type_auto_to_adaptive() -> None:
    payload = {
        "model": "claude-opus-4-6",
        "thinking": {"type": "auto"},
    }
    out = apply_vendor_thinking_request_payload(payload, base_url="https://api.example.com/v1")
    assert "thinking" not in out
    assert out["extra_body"]["thinking"] == {"type": "adaptive"}


def test_anthropic_style_sanitize_rewrites_auto_to_adaptive() -> None:
    model = SimpleNamespace(base_url="https://api.anthropic.com", vendor="anthropic")
    model_settings: dict = {}
    kwargs: dict = {"extra_body": {"thinking": {"type": "auto"}}}
    _sanitize_anthropic_style_thinking_settings(model, model_settings, kwargs)
    assert kwargs["extra_body"]["thinking"]["type"] == "adaptive"


def test_volc_keeps_thinking_type_auto() -> None:
    model = SimpleNamespace(
        base_url="https://ark.cn-beijing.volces.com/api/v3",
        vendor="volcengine",
    )
    model_settings: dict = {}
    kwargs: dict = {"extra_body": {"thinking": {"type": "auto"}}}
    _sanitize_anthropic_style_thinking_settings(model, model_settings, kwargs)
    assert kwargs["extra_body"]["thinking"]["type"] == "auto"


def test_vendor_auto_thinking_omits_thinking_kwargs() -> None:
    model = SimpleNamespace(
        base_url="https://api.example.com/v1",
        vendor="openai",
        supports_reasoning_effort=False,
        when_thinking_enabled={"extra_body": {"thinking": {"type": "enabled"}}},
        thinking=None,
    )
    model_settings: dict = {"extra_body": {"enable_thinking": True, "foo": 1}}
    kwargs: dict = {"reasoning_effort": "high", "extra_body": {"thinking": {"type": "enabled"}}}
    assert _apply_vendor_auto_thinking(model, model_settings, kwargs, ChatOpenAI) is True
    assert "reasoning_effort" not in kwargs
    assert "thinking" not in kwargs.get("extra_body", {})
    assert "enable_thinking" not in model_settings.get("extra_body", {})
    assert model_settings.get("extra_body", {}).get("foo") == 1
