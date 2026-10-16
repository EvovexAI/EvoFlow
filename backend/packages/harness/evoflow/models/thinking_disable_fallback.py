"""One-shot degrade when a vendor rejects ``thinking.type=disabled`` with a 400.

部分厂商（如 Volc Ark 的非 thinking 模型）对显式 ``thinking.type=disabled``
直接回 400 ``thinking.type 'disabled' is not supported by this model``。
处理：实例级记忆该模型不支持显式关闭 → 后续请求剥离全部 thinking 参数，
让厂商默认生效；``vendor_roundtrip`` mixin 捕获该特定 400 后置位并重试一次。
"""

from __future__ import annotations

from typing import Any

# 实例属性名：模型被观测到拒绝显式 disable 后置位（进程内记忆）。
THINKING_DISABLE_UNSUPPORTED_ATTR = "_evoflow_thinking_disable_unsupported"

_UNSUPPORTED_MARKER = "is not supported by this model"

# 剥离字段：厂商 thinking 开关的三种形态（显式 dict / OpenAI effort / 布尔开关），
# 以及 normalize 后写入 extra_body 的 reasoning 块。
_PAYLOAD_KEYS = ("thinking", "reasoning", "reasoning_effort", "enable_thinking")
_EXTRA_BODY_KEYS = ("thinking", "reasoning", "enable_thinking", "thinking_budget", "thinkingBudget")


def is_thinking_unsupported_400(e: Any) -> bool:
    """True for the specific ``thinking.type disabled`` 400 rejection."""
    if e is None:
        return False
    status = getattr(e, "status_code", None)
    if status is not None and status != 400:
        return False
    name = type(e).__name__
    if status is None and "BadRequest" not in name and "HTTPStatusError" not in name:
        # 非 400 形态的异常（超时/连接类）不触发降级。
        return False
    msg = str(e).lower()
    return "thinking" in msg and _UNSUPPORTED_MARKER in msg


def strip_thinking_params(payload: dict[str, Any]) -> dict[str, Any]:
    """Remove every thinking-switch variant from the outgoing request payload."""
    if not isinstance(payload, dict):
        return payload
    for key in _PAYLOAD_KEYS:
        payload.pop(key, None)
    extra = payload.get("extra_body")
    if isinstance(extra, dict):
        for key in _EXTRA_BODY_KEYS:
            extra.pop(key, None)
        if not extra:
            payload.pop("extra_body", None)
    return payload


def mark_thinking_disable_unsupported(model_instance: Any | None) -> None:
    """Remember on the instance that explicit thinking-disable is rejected."""
    if model_instance is None:
        return
    try:
        setattr(model_instance, THINKING_DISABLE_UNSUPPORTED_ATTR, True)
    except Exception:
        pass


def thinking_disable_unsupported(model_instance: Any | None) -> bool:
    return bool(getattr(model_instance, THINKING_DISABLE_UNSUPPORTED_ATTR, False))
