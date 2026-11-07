"""One-shot degrade when a vendor rejects our ``thinking`` parameter with a 400.

两类 400 都收口到这里（本质同一件事：这个模型不吃这种 thinking 写法）：

1. 显式关闭被拒 —— 如 Volc Ark 的非 thinking 模型回
   ``thinking.type 'disabled' is not supported by this model``。
2. 严格模式只认特定写法 —— 走 OpenAI 兼容代理的 Claude（vip.ai-api.cc 等）回
   ``requires adaptive thinking or thinking.type=between_tools``。

处理：实例级记忆该模型不吃 thinking → 后续请求剥离全部 thinking 参数，
让厂商默认生效；``vendor_roundtrip`` mixin 捕获该 400 后置位并重试一次。
"""

from __future__ import annotations

from typing import Any

# 实例属性名：模型被观测到拒绝显式 disable 后置位（进程内记忆）。
THINKING_DISABLE_UNSUPPORTED_ATTR = "_evoflow_thinking_disable_unsupported"

_UNSUPPORTED_MARKER = "is not supported by this model"

# 严格模式厂商（OpenAI 兼容代理上的 Claude）：只接受 adaptive / between_tools，
# 其余 thinking 写法一律 400。
_STRICT_MODE_MARKER = "requires adaptive thinking"

# 剥离字段：厂商 thinking 开关的三种形态（显式 dict / OpenAI effort / 布尔开关），
# 以及 normalize 后写入 extra_body 的 reasoning 块。
_PAYLOAD_KEYS = ("thinking", "reasoning", "reasoning_effort", "enable_thinking")
_EXTRA_BODY_KEYS = ("thinking", "reasoning", "enable_thinking", "thinking_budget", "thinkingBudget")


def is_thinking_unsupported_400(e: Any) -> bool:
    """True when the vendor 400s because it refuses our ``thinking`` parameter.

    两类都在此收口（都是「这个模型不吃这个 thinking 写法」）：
    1. 显式关闭被拒：``thinking.type 'disabled' is not supported by this model``（Volc Ark 等）
    2. 严格模式只认特定写法：``requires adaptive thinking or thinking.type=between_tools``
       （走 OpenAI 兼容代理的 Claude，vip.ai-api.cc 等）
    处理方式相同：记住该实例不吃 thinking，重试时整段剥掉。
    """
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
    if "thinking" not in msg:
        return False
    return _UNSUPPORTED_MARKER in msg or _STRICT_MODE_MARKER in msg


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
