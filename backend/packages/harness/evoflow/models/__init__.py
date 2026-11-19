"""Model factory + OpenAI-compatible invoke helpers.

【self-evolution-bot · 2026-11-19 · 第61轮 · 模型:deepseek-v4.1-flash-1017】
改了什么：把两个顶层 `from .x import ...` 改成**懒加载**（PEP 562 模块级 `__getattr__`）。
为什么：`from evoflow.models.credential_sanitize import is_masked_api_key` 这类
**子模块**导入会先执行本文件，而本文件原来无条件 `from .factory import ...`，
于是为了拿一个纯字符串函数，把
  `langchain_core.language_models.base` 1965ms
  → `transformers` 725ms
  → `torch` 892ms
整条模型栈拖进来。实测本包 import **2704ms（cumulative）**。

现网后果（不是理论）：gateway 重启后首个 `/api/tasks` 请求
`kind=tasks_catalog duration_ms=9876 acquire_ms=0 inflight=1` —— 不是排队、不是 SQL，
是路由顶层 `from evoflow.admin.platform_handlers import ...` 把这条路
一路拖到 torch。11-18 与 11-19 两次重启后各出现一次（10000ms / 9876ms）。

改后实测：`evoflow.admin.platform_handlers` 首次 import **2437.5ms → 见同轮验收数字**。

边界：`__all__` 保留，公开名字一个不少；`from evoflow.models import create_chat_model`
与 `import evoflow.models; evoflow.models.create_chat_model` 两种写法行为不变，
只是**第一次真正取用时**才付那笔 import。`dir()` 也照常列出公开名。
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "create_chat_model",
    "OpenAICompatError",
    "ainvoke_chat_completion",
    "invoke_chat_completion",
    "list_configured_models_openai",
    "vision_messages",
]

_LAZY_ATTRS = {
    "create_chat_model": ("evoflow.models.factory", "create_chat_model"),
    "OpenAICompatError": ("evoflow.models.openai_compat_invoke", "OpenAICompatError"),
    "ainvoke_chat_completion": (
        "evoflow.models.openai_compat_invoke",
        "ainvoke_chat_completion",
    ),
    "invoke_chat_completion": (
        "evoflow.models.openai_compat_invoke",
        "invoke_chat_completion",
    ),
    "list_configured_models_openai": (
        "evoflow.models.openai_compat_invoke",
        "list_configured_models_openai",
    ),
    "vision_messages": ("evoflow.models.openai_compat_invoke", "vision_messages"),
}


def __getattr__(name: str) -> Any:
    """PEP 562：首次访问才 import 真正的实现模块。"""
    target = _LAZY_ATTRS.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import importlib

    module_name, attr = target
    value = getattr(importlib.import_module(module_name), attr)
    globals()[name] = value  # 缓存，后续访问不再走这里
    return value


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(__all__))
