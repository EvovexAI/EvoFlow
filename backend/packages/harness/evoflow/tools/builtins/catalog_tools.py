"""Read-only catalogs: assignable tools and known skills (for agent governance)."""

import json
import logging
from typing import Annotated

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT

from evoflow.config.agent_resource_validation import model_name_from_tool_runtime

logger = logging.getLogger(__name__)

list_assignable_tools_tool_ui_metadata = {
    "label": "可分配工具列表",
    "icon": "🧰",
    "group": "agent_management",
    "description": "列出当前环境可写入自定义智能体的工具名（与 create_agent / update_agent 校验一致）",
}
list_skills_catalog_tool_ui_metadata = {
    "label": "技能目录",
    "icon": "📚",
    "group": "agent_management",
    "description": "列出已安装技能的 id（与 create_agent / update_agent 的 skills 校验一致）",
}


@tool("list_assignable_tools")
async def list_assignable_tools_tool(
    runtime: ToolRuntime[ContextT, dict],
    tool_call_id: Annotated[str, InjectedToolCallId],
) -> str:
    """List tool names that may be assigned to custom agents (create_agent / update_agent / worker_profile).

    Names match the runtime tool catalog (same set used when validating agent configs). Call this before
    setting ``tools`` or ``disallowed_tools`` so values are exact string matches.
    """
    from evoflow.tools import get_available_tools

    model_name = model_name_from_tool_runtime(runtime)
    try:
        tools = get_available_tools(model_name=model_name, subagent_enabled=False)
    except Exception as e:
        logger.exception("list_assignable_tools: get_available_tools failed")
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)

    rows: list[dict[str, str]] = []
    for t in tools:
        n = getattr(t, "name", None)
        if not n:
            continue
        desc = getattr(t, "description", None) or ""
        desc = str(desc).replace("\n", " ").strip()[:280]
        rows.append({"name": str(n), "description": desc})
    rows.sort(key=lambda x: x["name"])

    return json.dumps(
        {
            "success": True,
            "count": len(rows),
            "model_name": model_name,
            "tools": rows,
            "hint": "在 create_agent / update_agent 的 tools / disallowed_tools 中必须使用上表精确的 name 字段；创建角色前请先调用本工具。",
        },
        ensure_ascii=False,
    )


@tool("list_skills_catalog")
async def list_skills_catalog_tool(
    runtime: ToolRuntime[ContextT, dict],
    tool_call_id: Annotated[str, InjectedToolCallId],
    include_disabled: bool = False,
) -> str:
    """List installed skills (id + short description + main file path).

    Use ``include_disabled=true`` to include skills turned off in extensions config. Skill ids must match
    exactly for ``create_agent`` / ``update_agent`` ``skills`` arrays.
    """
    from evoflow.skills import load_skills

    try:
        skills = load_skills(enabled_only=not include_disabled)
    except Exception as e:
        logger.exception("list_skills_catalog: load_skills failed")
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)

    rows: list[dict[str, str]] = []
    for s in skills:
        try:
            loc = str(s.skill_file.resolve())
        except Exception:
            loc = str(s.skill_file)
        rows.append(
            {
                "name": str(s.name),
                "description": (s.description or "").replace("\n", " ").strip()[:280],
                "location": loc,
            }
        )
    rows.sort(key=lambda x: x["name"])

    return json.dumps(
        {
            "success": True,
            "count": len(rows),
            "include_disabled": include_disabled,
            "skills": rows,
            "hint": "create_agent / update_agent 的 skills 列表只能使用上表 name；创建前请先调用本工具。",
        },
        ensure_ascii=False,
    )
