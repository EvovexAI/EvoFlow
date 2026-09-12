"""Volcengine thinking budget vs max_tokens alignment in model factory."""

from __future__ import annotations

from types import SimpleNamespace

from evoflow.models.factory import (
    _align_volcengine_thinking_output_budget,
    _effective_max_output_tokens,
    _volc_completion_reserve_tokens,
)


def _volc_model(**overrides) -> SimpleNamespace:
    base = dict(
        name="glm-5.2",
        base_url="https://ark.cn-beijing.volces.com/api/plan/v3",
        vendor="volcengine",
        max_tokens=65536,
        output_context_length=65536,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def test_effective_max_output_tokens_uses_output_context_length() -> None:
    model = _volc_model(max_tokens=32768, output_context_length=65536)
    assert _effective_max_output_tokens(model, {"max_tokens": 32768}) == 65536


def test_volc_completion_reserve_defaults_to_16k() -> None:
    assert _volc_completion_reserve_tokens(65536) == 16384


def test_align_volc_thinking_honors_explicit_budget(monkeypatch) -> None:
    monkeypatch.delenv("EVOFLOW_VOLC_ASSUMED_OUTPUT_CAP", raising=False)
    monkeypatch.delenv("EVOFLOW_VOLC_COMPLETION_RESERVE_TOKENS", raising=False)
    model = _volc_model()
    model_settings = {"max_tokens": 65536}
    kwargs: dict = {"extra_body": {"thinking": {"type": "enabled", "budget_tokens": 2048}}}
    _align_volcengine_thinking_output_budget(model, model_settings, kwargs)
    thinking = kwargs["extra_body"]["thinking"]
    assert thinking["type"] == "enabled"
    assert thinking["budget_tokens"] == 2048
    assert model_settings["max_tokens"] == 65536


def test_align_volc_thinking_maps_reasoning_effort(monkeypatch) -> None:
    monkeypatch.delenv("EVOFLOW_VOLC_ASSUMED_OUTPUT_CAP", raising=False)
    monkeypatch.delenv("EVOFLOW_VOLC_COMPLETION_RESERVE_TOKENS", raising=False)
    model = _volc_model()
    model_settings = {"max_tokens": 65536}
    kwargs: dict = {
        "extra_body": {"thinking": {"type": "enabled"}},
        "_evoflow_reasoning_effort": "medium",
    }
    _align_volcengine_thinking_output_budget(model, model_settings, kwargs)
    assert kwargs["extra_body"]["thinking"]["budget_tokens"] == 16384


def test_align_respects_assumed_output_cap(monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_VOLC_ASSUMED_OUTPUT_CAP", "16384")
    monkeypatch.delenv("EVOFLOW_VOLC_COMPLETION_RESERVE_TOKENS", raising=False)
    model = _volc_model()
    model_settings = {"max_tokens": 65536}
    kwargs: dict = {"extra_body": {"thinking": {"type": "enabled"}}}
    _align_volcengine_thinking_output_budget(model, model_settings, kwargs)
    thinking = kwargs["extra_body"]["thinking"]
    # cap 16384 - reserve 16384 would be 0; fallback splits ~50/50
    assert thinking["budget_tokens"] == 8192
    assert model_settings["max_tokens"] >= 16384
