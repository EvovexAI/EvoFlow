"""Native tool names/descriptions for agent role UI (Gateway / EvoPanel).

Merges sandbox and host_direct tool surfaces so the role editor lists every name
the lead agent may bind at runtime (excluding MCP-prefixed tools).
"""

from __future__ import annotations

import logging
from typing import Any

# NOTE: Delayed import to avoid circular import:
# ui_metadata -> tools -> builtins -> supervisor -> subagents -> executor -> gateway -> ui_metadata
# The import is done inside the function instead of at module level.

logger = logging.getLogger(__name__)


# LangChain @tool wraps __module__ as langchain_core.* — map back to defining modules.
_BUILTIN_TOOL_UI_SOURCE_MODULES: dict[str, str] = {
    "panel_set": "evoflow.tools.builtins.stage_tool",
    "stage_set": "evoflow.tools.builtins.stage_tool",
    "session_workspace": "evoflow.tools.builtins.session_workspace_tool",
    "propose_goal": "evoflow.tools.builtins.propose_goal_tool",
}

# 中间件注入工具（不在 get_available_tools 注册表里）的手工 UI spec：
# todo_write 由 TodoMiddleware 挂载（zcode TodoWrite 对齐），主智能体恒挂载，
# 子智能体按白名单勾选后由 SubagentExecutor 挂载。
_MIDDLEWARE_TOOL_UI_SPECS: tuple[dict[str, Any], ...] = (
    {
        "name": "todo_write",
        "group": "planning",
        "label": "待办事项",
        "description": (
            "会话内待办清单管理（zcode TodoWrite 对齐）：全量替换式更新任务清单，"
            "结构化输出供前端待办面板与 V4 时间线清单卡片渲染。"
            "按角色白名单按需注入：勾选后挂载工具并注入系统提示词段，"
            "未配置白名单（全量继承）时默认挂载。"
        ),
        "icon": "📋",
    },
)


def _read_tool_ui_metadata(name: str, tool_module: str | None) -> dict[str, Any]:
    import importlib

    modules_to_try: list[str] = []
    if name in _BUILTIN_TOOL_UI_SOURCE_MODULES:
        modules_to_try.append(_BUILTIN_TOOL_UI_SOURCE_MODULES[name])
    if tool_module and str(tool_module).startswith("evoflow."):
        modules_to_try.append(str(tool_module))

    meta_var_names = (
        f"{name}_tool_ui_metadata",
        f"{name}_ui_metadata",
    )
    for mod_path in modules_to_try:
        try:
            mod = importlib.import_module(mod_path)
        except Exception:
            continue
        for var_name in meta_var_names:
            if hasattr(mod, var_name):
                raw = getattr(mod, var_name) or {}
                if isinstance(raw, dict) and raw:
                    return raw
    return {}


def collect_native_tool_specs_for_role_ui(*, model_name: str | None = None) -> list[dict[str, Any]]:
    """Return one entry per native tool name for the preset-role tools checklist.

    Calls ``get_available_tools`` twice (sandbox + host_direct) with ``include_mcp=False``,
    then merges by tool name. MCP tools stay on the MCP tab; deferred ``tool_search`` is
    added separately by the Gateway when enabled.
    """
    # Delayed import to avoid circular import
    from evoflow.tools.tools import get_available_tools

    modes: tuple[str, ...] = ("sandbox", "host_direct")
    by_name: dict[str, dict[str, Any]] = {}

    for mode in modes:
        try:
            tools = get_available_tools(
                groups=None,
                include_mcp=False,
                model_name=model_name,
                subagent_enabled=True,
                include_search=True,
                tools_mode=mode,
            )
        except Exception as e:
            logger.debug("ui_metadata: skip tools_mode=%s: %s", mode, e)
            continue

        for t in tools:
            name = getattr(t, "name", None) or ""
            if not name or "__" in name:
                continue

            ui_meta = _read_tool_ui_metadata(name, getattr(t, "__module__", None))

            desc_raw = getattr(t, "description", None) or ""
            desc = desc_raw.strip() if isinstance(desc_raw, str) else ""
            group = getattr(t, "group", None) or ""

            # host_direct is the live catalog; overwrite the sandbox row of the same name.
            if name not in by_name or mode == "host_direct":
                by_name[name] = {
                    "name": name,
                    "group": ui_meta.get("group") or group,
                    "description": ui_meta.get("description") or desc,
                    "label": ui_meta.get("label"),
                    "icon": ui_meta.get("icon"),
                }
            else:
                prev = by_name[name]
                # Prefer UI metadata over default values
                if not prev.get("group") and (ui_meta.get("group") or group):
                    prev["group"] = ui_meta.get("group") or group
                if not prev.get("description") and ui_meta.get("description"):
                    prev["description"] = ui_meta.get("description")
                elif not prev.get("description"):
                    prev_desc = (prev.get("description") or "").strip()
                    if len(desc) > len(prev_desc):
                        prev["description"] = desc
                # Store label and icon for UI
                if ui_meta.get("label"):
                    prev["label"] = ui_meta.get("label")
                if ui_meta.get("icon"):
                    prev["icon"] = ui_meta.get("icon")

    # Merge middleware-provided tools (never in the registry) so the role editor
    # can list them; registry entries win on conflict.
    for spec in _MIDDLEWARE_TOOL_UI_SPECS:
        name = str(spec.get("name") or "").strip()
        if name and name not in by_name:
            by_name[name] = dict(spec)

    from evoflow.tools.tool_catalog import (
        catalog_fields_for_tool_name,
        is_role_editor_configurable_tool,
        tier_sort_key,
    )

    for name, spec in by_name.items():
        spec.update(catalog_fields_for_tool_name(name))

    configurable = [spec for spec in by_name.values() if is_role_editor_configurable_tool(spec.get("name"))]
    return sorted(configurable, key=lambda x: (tier_sort_key(x.get("tool_type")), str(x.get("name") or "")))
