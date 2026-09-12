"""Vendor thinking payload normalization tests."""

from __future__ import annotations

from types import SimpleNamespace

from evoflow.models.vendor_thinking_payload import apply_vendor_thinking_request_payload

_DASHSCOPE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
_ZHIPU = "https://open.bigmodel.cn/api/paas/v4"
_VOLC = "https://ark.cn-beijing.volces.com/api/v3"


def test_dashscope_maps_effort_to_thinking_budget() -> None:
    model = SimpleNamespace(_evoflow_thinking_enabled=True, _evoflow_reasoning_effort="low")
    payload = {
        "model": "qwen-plus",
        "extra_body": {"enable_thinking": True},
        "reasoning_effort": "low",
    }
    out = apply_vendor_thinking_request_payload(payload, base_url=_DASHSCOPE, model_instance=model)
    assert out["extra_body"]["enable_thinking"] is True
    assert out["extra_body"]["thinking_budget"] == 8192
    assert "reasoning_effort" not in out
    assert "thinking" not in out.get("extra_body", {})


def test_zhipu_official_shape() -> None:
    model = SimpleNamespace(
        _evoflow_thinking_enabled=True,
        _evoflow_reasoning_effort="high",
        model_name="glm-4.7",
    )
    payload = {
        "model": "glm-4.7",
        "extra_body": {"thinking": {"type": "enabled"}},
    }
    out = apply_vendor_thinking_request_payload(payload, base_url=_ZHIPU, model_instance=model)
    assert out["extra_body"]["thinking"] == {"type": "enabled"}
    assert out["extra_body"]["reasoning_effort"] == "high"
    assert "thinking" not in out
    assert "reasoning_effort" not in out


def test_zhipu_glm_maps_xhigh_to_max() -> None:
    model = SimpleNamespace(
        _evoflow_thinking_enabled=True,
        _evoflow_reasoning_effort="xhigh",
        model_name="glm-5.2",
    )
    payload = {"model": "glm-5.2", "extra_body": {"thinking": {"type": "enabled"}}}
    out = apply_vendor_thinking_request_payload(payload, base_url=_ZHIPU, model_instance=model)
    assert out["extra_body"]["reasoning_effort"] == "max"


def test_zhipu_disabled_uses_extra_body_not_top_level() -> None:
    model = SimpleNamespace(_evoflow_thinking_enabled=False, _evoflow_reasoning_effort="minimal")
    payload = {"model": "glm-5.2", "extra_body": {"thinking": {"type": "enabled"}}}
    out = apply_vendor_thinking_request_payload(payload, base_url=_ZHIPU, model_instance=model)
    assert out["extra_body"]["thinking"] == {"type": "disabled"}
    assert "thinking" not in out


def test_volc_still_uses_reasoning_effort_object() -> None:
    model = SimpleNamespace(_evoflow_thinking_enabled=True, _evoflow_reasoning_effort="medium")
    payload = {
        "model": "doubao-seed-2.0-pro",
        "max_completion_tokens": 65536,
        "extra_body": {"thinking": {"type": "enabled"}, "reasoning": {"effort": "medium"}},
    }
    out = apply_vendor_thinking_request_payload(payload, base_url=_VOLC, model_instance=model)
    assert out["extra_body"]["thinking"] == {"type": "enabled"}
    assert out["extra_body"]["reasoning"] == {"effort": "medium"}
    assert "thinking" not in out
