"""Package exports resolved on demand (PEP 562 lazy).

【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】

## 改了什么
原来 13 个名字在包导入期无条件 import，任何
``from <pkg>.<子模块> import ...`` 都要先执行本文件（Python 语义：子模块 import 必先执行包 ``__init__``）。

## 为什么改
这些重导出把 langchain / transformers / torch / 本地嵌入 provider 拖进进程，
而实际调用方几乎都直接 import 子模块，父包级重导出没有人用。

## 边界
- 名字不变：``__all__`` 13 个一个不少，``dir()`` 照常列出。
- **1 个导出名同时是子模块名**（['consolidate']…）。
  原版 ``from .x_tool import x_tool`` 的最终效果就是**包属性 = 工具对象**（子模块属性被覆盖），
  本实现同样返回工具对象，语义一致；``import <pkg>.<子模块>`` 走 ``sys.modules`` 不受影响。
"""

from __future__ import annotations

from typing import Any

_LAZY_ATTRS = {
    "agent_ns": "namespaces",
    "consolidate": "facade",
    "forget": "facade",
    "get_core": "facade",
    "list_atoms": "facade",
    "mark_atom_stale": "facade",
    "mark_related_memories_stale": "facade",
    "person_ns": "namespaces",
    "pin_atom": "facade",
    "recall": "facade",
    "remember": "facade",
    "user_ns": "namespaces",
    "workspace_ns": "namespaces",
}

__all__ = [
    "agent_ns",
    "consolidate",
    "forget",
    "get_core",
    "list_atoms",
    "mark_atom_stale",
    "mark_related_memories_stale",
    "person_ns",
    "pin_atom",
    "recall",
    "remember",
    "user_ns",
    "workspace_ns",
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
