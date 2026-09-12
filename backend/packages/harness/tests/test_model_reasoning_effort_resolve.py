"""Model Settings → thinking.default_level wired into vendor reasoning effort."""

from __future__ import annotations

from types import SimpleNamespace

from evoflow.models.factory import (
    _VOLC_THINKING_BUDGET_BY_EFFORT,
    _align_volcengine_thinking_output_budget,
    _sanitize_volcengine_thinking_settings,
    resolve_effective_reasoning_effort,
)


def _model(**thinking: object) -> SimpleNamespace:
    return SimpleNamespace(
        name="glm-5.2",
        thinking=thinking or None,
        supports_reasoning_effort=True,
    )


def test_resolve_model_default_thinking_mode() -> None:
    from evoflow.models.factory import resolve_model_default_thinking_mode

    assert resolve_model_default_thinking_mode(None) == "auto"
    assert resolve_model_default_thinking_mode(_model(default_mode="disabled")) == "disabled"
    assert resolve_model_default_thinking_mode(_model(default_mode="enabled")) == "enabled"
    assert resolve_model_default_thinking_mode(_model(default_mode="auto")) == "auto"
    assert resolve_model_default_thinking_mode(_model(defaultMode="off")) == "disabled"


def test_model_default_level_used_when_runtime_empty() -> None:
    model = _model(default_level="high", supported_levels=["low", "medium", "high"])
    assert resolve_effective_reasoning_effort(None, model, thinking_enabled=True) == "high"


def test_runtime_effort_wins_over_model_default() -> None:
    model = _model(default_level="high", supported_levels=["low", "medium", "high"])
    assert resolve_effective_reasoning_effort("low", model, thinking_enabled=True) == "low"


def test_auto_default_level_falls_back_to_runtime() -> None:
    model = _model(default_level="auto", supported_levels=[])
    assert resolve_effective_reasoning_effort("low", model, thinking_enabled=True) == "low"


def test_empty_runtime_uses_medium_when_no_model_default() -> None:
    model = _model(default_level="auto")
    assert resolve_effective_reasoning_effort(None, model, thinking_enabled=True) == "medium"


def test_supported_levels_clamp_unknown_runtime() -> None:
    model = _model(default_level="auto", supported_levels=["low", "medium"])
    assert resolve_effective_reasoning_effort("xhigh", model, thinking_enabled=True) == "low"


def test_volc_align_floor_uses_model_default_effort(monkeypatch) -> None:
    monkeypatch.delenv("EVOFLOW_VOLC_ASSUMED_OUTPUT_CAP", raising=False)
    monkeypatch.delenv("EVOFLOW_VOLC_COMPLETION_RESERVE_TOKENS", raising=False)
    model = SimpleNamespace(
        name="glm-5.2",
        base_url="https://ark.cn-beijing.volces.com/api/plan/v3",
        vendor="volcengine",
        max_tokens=65536,
        output_context_length=65536,
        thinking={"default_level": "low", "supported_levels": ["low", "medium", "high"]},
        supports_reasoning_effort=False,
    )
    model_settings = {"max_tokens": 65536}
    kwargs: dict = {
        "extra_body": {"thinking": {"type": "enabled"}},
        "_evoflow_reasoning_effort": resolve_effective_reasoning_effort(None, model, thinking_enabled=True),
    }
    _align_volcengine_thinking_output_budget(model, model_settings, kwargs)
    budget = kwargs["extra_body"]["thinking"]["budget_tokens"]
    assert budget == _VOLC_THINKING_BUDGET_BY_EFFORT["low"]


def test_volc_modern_api_passes_reasoning_effort_not_budget_tokens() -> None:
    model = SimpleNamespace(
        name="glm-5.2",
        model="glm-5.2",
        base_url="https://ark.cn-beijing.volces.com/api/plan/v3",
        vendor="volcengine",
        supports_reasoning_effort=True,
    )
    model_settings: dict = {"max_tokens": 65536}
    kwargs: dict = {
        "extra_body": {"thinking": {"type": "enabled"}},
        "_evoflow_reasoning_effort": "medium",
    }
    _sanitize_volcengine_thinking_settings(model, model_settings, kwargs)
    assert kwargs["extra_body"]["reasoning"] == {"effort": "medium"}
    assert kwargs["extra_body"]["thinking"] == {"type": "enabled"}
    assert "budget_tokens" not in kwargs["extra_body"]["thinking"]
    assert "reasoning_effort" not in kwargs


def test_volc_glm_maps_xhigh_to_max() -> None:
    model = SimpleNamespace(
        name="glm-5.2",
        model="glm-5.2",
        base_url="https://ark.cn-beijing.volces.com/api/plan/v3",
        vendor="volcengine",
        supports_reasoning_effort=True,
    )
    model_settings: dict = {}
    kwargs: dict = {
        "extra_body": {"thinking": {"type": "enabled"}},
        "_evoflow_reasoning_effort": "xhigh",
    }
    _sanitize_volcengine_thinking_settings(model, model_settings, kwargs)
    assert kwargs["extra_body"]["reasoning"] == {"effort": "max"}
