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

            if name not in by_name:
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

    from evoflow.tools.tool_catalog import (
        catalog_fields_for_tool_name,
        is_role_editor_configurable_tool,
        tier_sort_key,
    )

    for name, spec in by_name.items():
        spec.update(catalog_fields_for_tool_name(name))

    configurable = [spec for spec in by_name.values() if is_role_editor_configurable_tool(spec.get("name"))]
    return sorted(configurable, key=lambda x: (tier_sort_key(x.get("tool_type")), str(x.get("name") or "")))
