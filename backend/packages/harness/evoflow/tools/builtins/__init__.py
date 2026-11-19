"""Package exports resolved on demand (PEP 562 lazy).

【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】

## 改了什么
原来 32 个名字在包导入期无条件 import，任何
``from <pkg>.<子模块> import ...`` 都要先执行本文件（Python 语义：子模块 import 必先执行包 ``__init__``）。

## 为什么改
这些重导出把 langchain / transformers / torch / 本地嵌入 provider 拖进进程，
而实际调用方几乎都直接 import 子模块，父包级重导出没有人用。

## 边界
- 名字不变：``__all__`` 31 个一个不少，``dir()`` 照常列出。
- **20 个导出名同时是子模块名**（['automation_tool', 'create_agent_tool', 'goal_report_tool']…）。
  原版 ``from .x_tool import x_tool`` 的最终效果就是**包属性 = 工具对象**（子模块属性被覆盖），
  本实现同样返回工具对象，语义一致；``import <pkg>.<子模块>`` 走 ``sys.modules`` 不受影响。
"""

from __future__ import annotations

from typing import Any

_LAZY_ATTRS = {
    "plan_tool": "plan_tool",
    "ask_clarification_tool": "clarification_tool",
    "view_image_tool": "view_image_tool",
    "task_tool": "task_tool",
    "tasks_tool": "tasks_tool",
    "supervisor_tool": "supervisor_tool",
    "done_tool": "subtask_outcome_report_tool",
    "progress_tool": "subtask_progress_tool",
    "checklist_tool": "subtask_work_checklist_tool",
    "peer_send_tool": "collab_peer_tools",
    "peer_read_tool": "collab_peer_tools",
    "peer_reply_tool": "collab_peer_tools",
    "todo_tool": "todo_tool",
    "propose_goal_tool": "propose_goal_tool",
    "goal_report_tool": "goal_report_tool",
    "knowledge_tool": "knowledge_tool",
    "search_knowledge_base_tool": "kb_search_tool",
    "platform_tool": "platform_tool",
    "automation_tool": "automation_tool",
    "create_agent_tool": "create_agent_tool",
    "update_agent_tool": "update_agent_tool",
    "list_assignable_tools_tool": "catalog_tools",
    "list_skills_catalog_tool": "catalog_tools",
    "list_agents_tool": "list_agents_tool",
    "skill_manager_tool": "skill_manager_tool",
    "panel_set_tool": "stage_tool",
    "stage_set_tool": "stage_tool",
    "process_tool": "process_tool",
    "read_lints_tool": "read_lints_tool",
    "person_memory_edit_tool": "person_memory_edit_tool",
    "memory_remember_tool": "memory_remember_tool",
}

__all__ = [
    "plan_tool",
    "ask_clarification_tool",
    "view_image_tool",
    "task_tool",
    "tasks_tool",
    "supervisor_tool",
    "done_tool",
    "progress_tool",
    "checklist_tool",
    "peer_send_tool",
    "peer_read_tool",
    "peer_reply_tool",
    "todo_tool",
    "propose_goal_tool",
    "goal_report_tool",
    "knowledge_tool",
    "search_knowledge_base_tool",
    "platform_tool",
    "automation_tool",
    "create_agent_tool",
    "update_agent_tool",
    "list_assignable_tools_tool",
    "list_skills_catalog_tool",
    "list_agents_tool",
    "skill_manager_tool",
    "panel_set_tool",
    "stage_set_tool",
    "process_tool",
    "read_lints_tool",
    "person_memory_edit_tool",
    "memory_remember_tool",
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
