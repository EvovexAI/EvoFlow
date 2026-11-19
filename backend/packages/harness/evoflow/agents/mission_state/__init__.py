"""Package exports resolved on demand (PEP 562 lazy).

【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】

## 改了什么
原来 8 个名字在包导入期无条件 import，任何
``from <pkg>.<子模块> import ...`` 都要先执行本文件（Python 语义：子模块 import 必先执行包 ``__init__``）。

## 为什么改
这些重导出把 langchain / transformers / torch / 本地嵌入 provider 拖进进程，
而实际调用方几乎都直接 import 子模块，父包级重导出没有人用。

## 边界
- 名字不变：``__all__`` 8 个一个不少，``dir()`` 照常列出。
- 导出名与本包子模块名无一撞车（已核）。
"""

from __future__ import annotations

from typing import Any

_LAZY_ATTRS = {
    "MissionState": "models",
    "get_mission_state_queue": "queue",
    "get_thread_state": "state_manager",
    "reset_thread_state": "state_manager",
    "decide_next_mode": "state_manager",
    "load_mission_state": "storage",
    "save_mission_state": "storage",
    "mission_state_file": "storage",
}

__all__ = [
    "MissionState",
    "get_mission_state_queue",
    "get_thread_state",
    "reset_thread_state",
    "decide_next_mode",
    "load_mission_state",
    "save_mission_state",
    "mission_state_file",
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
