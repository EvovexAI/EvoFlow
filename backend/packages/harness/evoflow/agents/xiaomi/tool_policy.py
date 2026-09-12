"""小V工具边界：平台管家系统工具（名册 / 看板 / 派发 / 催办 / 知识检索 / 平台行政）。

不问澄清、不读仓、不联网——先查员工与进度，再推进任务；用法/概念题走知识库；
平台杂活统一走通用内置工具 ``platform``（先 catalog 再执行；与 EvoFlow 同源）。
"""

from __future__ import annotations

from typing import Any, Iterable

# 小V系统工具（唯一允许面）— 行政用通用 ``platform``，不另起 xiaomi_*_admin
XIAOMI_SYSTEM_TOOL_NAMES = frozenset(
    {
        "xiaomi_org_status",
        "xiaomi_board_overview",
        "xiaomi_employee_brief",
        "xiaomi_task_brief",
        "xiaomi_dispatch",
        "xiaomi_wake",
        "xiaomi_knowledge_search",
        "platform",
    }
)

XIAOMI_ALLOWED_TOOLS = frozenset(XIAOMI_SYSTEM_TOOL_NAMES)

# 兼容旧名 / 文档：曾用 denylist；现以 allowlist 为准。
XIAOMI_DENIED_FRONTLINE = frozenset(
    {
        "ask_clarification",
        "write_file",
        "write",
        "write_to_file",
        "edit_file",
        "str_replace",
        "replace",
        "replace_in_file",
        "apply_patch",
        "notebook_edit",
        "multi_edit",
        "delete_file",
        "delete",
        "move_file",
        "terminal",
        "process",
        "plan",
        "supervisor",
        "task",
        "tool_search",
        "read",
        "web_search",
        "fetch_url",
    }
)
XIAOMI_DENIED_ASK = XIAOMI_DENIED_FRONTLINE


def filter_xiaomi_tools(
    tools: Iterable[Any],
    *,
    session_mode: str | None = None,
    intent_hint: str | None = None,
) -> list[Any]:
    """Keep only Xiaomi system tools (allowlist)."""
    _ = session_mode, intent_hint
    allowed = XIAOMI_ALLOWED_TOOLS
    out: list[Any] = []
    for t in tools:
        name = str(getattr(t, "name", "") or "").strip().lower()
        if name and name in allowed:
            out.append(t)
    return out
