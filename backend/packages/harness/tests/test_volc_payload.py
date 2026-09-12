"""Volcengine request payload adjustments (modern vs legacy thinking API)."""

from __future__ import annotations

from evoflow.models.volc_payload import (
    apply_volcengine_request_payload,
    apply_volcengine_thinking_output_limits,
    normalize_volcengine_modern_chat_request,
)

_VOLC_BASE = "https://ark.cn-beijing.volces.com/api/v3"


def test_modern_api_official_shape() -> None:
    payload = {
        "model": "glm-5.2",
        "max_completion_tokens": 65536,
        "reasoning_effort": "high",
        "extra_body": {"thinking": {"type": "enabled"}},
    }
    out = apply_volcengine_request_payload(payload, base_url=_VOLC_BASE)
    assert out["extra_body"]["thinking"] == {"type": "enabled"}
    assert out["extra_body"]["reasoning"] == {"effort": "high"}
    assert "reasoning_effort" not in out
    assert "thinking" not in out
    assert "reasoning" not in out
    assert out["max_completion_tokens"] == 65536


def test_modern_api_from_extra_body_reasoning() -> None:
    payload = {
        "model": "doubao-seed-2.0-pro",
        "max_completion_tokens": 65536,
        "extra_body": {
            "thinking": {"type": "enabled"},
            "reasoning": {"effort": "low"},
        },
    }
    out = normalize_volcengine_modern_chat_request(payload, base_url=_VOLC_BASE)
    assert out["extra_body"]["thinking"] == {"type": "enabled"}
    assert out["extra_body"]["reasoning"] == {"effort": "low"}
    assert "thinking" not in out


def test_legacy_api_still_injects_budget_tokens() -> None:
    payload = {
        "model": "doubao-seed-1-6",
        "max_completion_tokens": 65536,
        "extra_body": {"thinking": {"type": "enabled"}},
    }
    out = apply_volcengine_thinking_output_limits(payload, base_url=_VOLC_BASE)
    thinking = out["extra_body"]["thinking"]
    assert thinking["type"] == "enabled"
    assert isinstance(thinking.get("budget_tokens"), int)
    assert thinking["budget_tokens"] > 0
    assert isinstance(out.get("max_tokens"), int)
