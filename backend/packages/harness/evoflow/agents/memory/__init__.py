"""Package exports resolved on demand (PEP 562 lazy).

【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】

## 改了什么
原来 17 个名字在包导入期无条件 import，任何
``from <pkg>.<子模块> import ...`` 都要先执行本文件（Python 语义：子模块 import 必先执行包 ``__init__``）。

## 为什么改
这些重导出把 langchain / transformers / torch / 本地嵌入 provider 拖进进程，
而实际调用方几乎都直接 import 子模块，父包级重导出没有人用。

## 边界
- 名字不变：``__all__`` 17 个一个不少，``dir()`` 照常列出。
- 导出名与本包子模块名无一撞车（已核）。
"""

from __future__ import annotations

from typing import Any

_LAZY_ATTRS = {
    "MEMORY_UPDATE_PROMPT": "prompt",
    "FACT_EXTRACTION_PROMPT": "prompt",
    "format_memory_for_injection": "prompt",
    "format_conversation_for_update": "prompt",
    "ConversationContext": "queue",
    "MemoryUpdateQueue": "queue",
    "get_memory_queue": "queue",
    "reset_memory_queue": "queue",
    "MemoryStorage": "storage",
    "FileMemoryStorage": "storage",
    "get_memory_storage": "storage",
    "MemoryUpdater": "updater",
    "clear_memory_data": "updater",
    "delete_memory_fact": "updater",
    "get_memory_data": "updater",
    "reload_memory_data": "updater",
    "update_memory_from_conversation": "updater",
}

__all__ = [
    "MEMORY_UPDATE_PROMPT",
    "FACT_EXTRACTION_PROMPT",
    "format_memory_for_injection",
    "format_conversation_for_update",
    "ConversationContext",
    "MemoryUpdateQueue",
    "get_memory_queue",
    "reset_memory_queue",
    "MemoryStorage",
    "FileMemoryStorage",
    "get_memory_storage",
    "MemoryUpdater",
    "clear_memory_data",
    "delete_memory_fact",
    "get_memory_data",
    "reload_memory_data",
    "update_memory_from_conversation",
]


def __getattr__(name: str) -> Any:
    """首次访问才 import 实现模块，并写回 globals() 缓存。"""

    module_name = _LAZY_ATTRS.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import importlib

    module = importlib.import_module(f"{__name__}.{module_name}")
    value = getattr(module, name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(_LAZY_ATTRS))
