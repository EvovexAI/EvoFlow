"""thinking.type=disabled 被厂商 400 拒绝时的一次性降级重试。

用户症状（exe 桌面端日志）：proactive 值班 run 中 LLM 调用直接 400 ——
``thinking.type 'disabled' is not supported by this model``（Volc Ark 对
非 thinking 模型拒绝显式关闭）。修复：实例记忆该模型不支持显式 disable，
后续请求剥离全部 thinking 参数让厂商默认生效；vendor_roundtrip 捕获该
特定 400 后置位并立即重试一次。
"""

from __future__ import annotations

import sys
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
for p in (str(_BACKEND_ROOT), str(_BACKEND_ROOT / "packages" / "harness")):
    if p not in sys.path:
        sys.path.insert(0, p)

from evoflow.models.thinking_disable_fallback import (  # noqa: E402
    is_thinking_unsupported_400,
    mark_thinking_disable_unsupported,
    strip_thinking_params,
)


class _FakeBadRequest(Exception):
    status_code = 400


def test_detects_thinking_unsupported_400():
    e = _FakeBadRequest(
        "Error code: 400 - {'error': {'code': 'InvalidParameter', "
        "'message': 'thinking.type `disabled` is not supported by this model'}}"
    )
    assert is_thinking_unsupported_400(e) is True


def test_ignores_other_errors():
    assert is_thinking_unsupported_400(Exception("connection reset")) is False
    assert is_thinking_unsupported_400(Exception("thinking budget exceeded")) is False
    e_other_code = _FakeBadRequest("thinking.type `disabled` is not supported")
    e_other_code.status_code = 429
    assert is_thinking_unsupported_400(e_other_code) is False
    assert is_thinking_unsupported_400(None) is False


def test_strip_thinking_params_removes_all_variants():
    payload = {
        "model": "doubao-x",
        "messages": [{"role": "user", "content": "hi"}],
        "thinking": {"type": "disabled"},
        "reasoning_effort": "minimal",
        "extra_body": {
            "thinking": {"type": "disabled"},
            "enable_thinking": False,
            "reasoning": {"effort": "minimal"},
            "temperature": 0.7,
        },
    }
    out = strip_thinking_params(payload)
    assert "thinking" not in out
    assert "reasoning_effort" not in out
    extra = out["extra_body"]
    for key in ("thinking", "enable_thinking", "reasoning"):
        assert key not in extra
    # 无关字段保留
    assert extra["temperature"] == 0.7
    assert out["messages"] == payload["messages"]


def test_strip_thinking_params_handles_missing_fields():
    out = strip_thinking_params({"model": "x", "extra_body": {"temperature": 1}})
    assert out == {"model": "x", "extra_body": {"temperature": 1}}
    assert strip_thinking_params({}) == {}


def test_mark_sets_instance_flag():
    class _M:
        pass

    m = _M()
    assert getattr(m, "_evoflow_thinking_disable_unsupported", False) is False
    mark_thinking_disable_unsupported(m)
    assert m._evoflow_thinking_disable_unsupported is True
    assert mark_thinking_disable_unsupported(None) is None  # 不抛
