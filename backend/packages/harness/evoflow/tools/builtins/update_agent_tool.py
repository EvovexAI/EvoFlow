"""Tool for updating existing custom agents."""

import json
import logging
from typing import Annotated

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT

from evoflow.config.agent_resource_validation import (
    model_name_from_tool_runtime,
    normalize_str_or_list_argument,
    partition_skill_names,
    partition_tool_names,
)
from evoflow.config.agents_config import load_agent_config, save_agent_config
from evoflow.persistence import config_repositories as cfg_repo

logger = logging.getLogger(__name__)


# UI metadata for tool discovery (attached to function, not tool object)
update_agent_tool_ui_metadata = {"label": "更新智能体", "icon": "✏️", "group": "agent_management", "description": "更新现有智能体的配置，包括中文名、工具、技能等"}


@tool("update_agent")
async def update_agent_tool(
    runtime: ToolRuntime[ContextT, dict],
    tool_call_id: Annotated[str, InjectedToolCallId],
    agent_code: str,
    agent_name: str | None = None,
    agent_type: str | None = None,
    description: str | None = None,
    model: str | None = None,
    system_prompt: str | None = None,
    tools: list[str] | str | None = None,
    skills: list[str] | str | None = None,
    mcp_servers: list[str] | str | None = None,
    disallowed_tools: list[str] | str | None = None,
    max_turns: int | None = None,
    timeout_seconds: int | None = None,
    soul: str | None = None,
    tags: list[str] | None = None,
) -> str:
    """Update an existing custom agent's configuration.

    Omit ``model`` unless the user explicitly requests changing this agent's model override.

    Pass ``soul`` to overwrite ``agents/<agent_code>/SOUL.md`` (full file body). Omit the parameter to leave SOUL unchanged.

    ``tags`` updates the agent's tag labels (pass a list; e.g. ["核心", "代码"]). Pass an empty list to clear tags.
    """
    # Normalize agent code
    agent_code = agent_code.strip().lower()

    tools = normalize_str_or_list_argument(tools)
    skills = normalize_str_or_list_argument(skills)
    mcp_servers = normalize_str_or_list_argument(mcp_servers)
    disallowed_tools = normalize_str_or_list_argument(disallowed_tools)

    logger.info("update_agent_tool: agent_code=%s fields_to_update=%s", agent_code, [k for k, v in locals().items() if v is not None and k != "agent_code"])

    # Check if agent exists
    try:
        existing_config = load_agent_config(agent_code)
        if not existing_config:
            return json.dumps({"success": False, "error": f"Agent '{agent_code}' not found. Use create_agent to create it first."}, ensure_ascii=False)
    except FileNotFoundError:
        return json.dumps({"success": False, "error": f"Agent '{agent_code}' not found."}, ensure_ascii=False)

    # Build updates dict with only provided fields
    updates = {}

    if agent_name is not None:
        updates["agent_name"] = agent_name
    if description is not None:
        updates["description"] = description
    if model is not None:
        updates["model"] = model
    if system_prompt is not None:
        updates["system_prompt"] = system_prompt
    if tools is not None:
        updates["tools"] = tools
    if skills is not None:
        updates["skills"] = skills
    if mcp_servers is not None:
        updates["mcp_servers"] = mcp_servers
    if disallowed_tools is not None:
        updates["disallowed_tools"] = disallowed_tools
    if max_turns is not None:
        updates["max_turns"] = max_turns
    if timeout_seconds is not None:
        updates["timeout_seconds"] = timeout_seconds
    if tags is not None:
        from evoflow.config.agent_tags import normalize_tags

        updates["tags"] = normalize_tags(tags)
    if agent_type is not None:
        # Validate agent type
        if agent_type not in ["custom", "subagent", "acp"]:
            return json.dumps({"success": False, "error": f"Invalid agent_type '{agent_type}'. Must be 'custom', 'subagent', or 'acp'"}, ensure_ascii=False)
        # Validate system_prompt for subagent
        if agent_type == "subagent" and not (system_prompt or getattr(existing_config, "system_prompt", None)):
            return json.dumps({"success": False, "error": "system_prompt is required when updating agent type to 'subagent'"}, ensure_ascii=False)
        updates["agent_type"] = agent_type

    if not updates and soul is None:
        return json.dumps({"success": False, "error": "No update parameters provided. Specify at least one field to update."}, ensure_ascii=False)

    mn = model_name_from_tool_runtime(runtime)
    if "tools" in updates:
        _, bad_t = partition_tool_names(updates["tools"], model_name=mn)
        if bad_t:
            return json.dumps(
                {
                    "success": False,
                    "error": f"Unknown tool names: {bad_t}. Call list_assignable_tools first.",
                    "unknown_tools": bad_t,
                },
                ensure_ascii=False,
            )
    if "disallowed_tools" in updates:
        _, bad_d = partition_tool_names(updates["disallowed_tools"], model_name=mn)
        if bad_d:
            return json.dumps(
                {
                    "success": False,
                    "error": f"Unknown disallowed_tools names: {bad_d}. Call list_assignable_tools first.",
                    "unknown_disallowed_tools": bad_d,
                },
                ensure_ascii=False,
            )
    if "skills" in updates:
        _, bad_s = partition_skill_names(updates["skills"], enabled_only=True)
        if bad_s:
            return json.dumps(
                {
                    "success": False,
                    "error": f"Unknown skill names: {bad_s}. Call list_skills_catalog first.",
                    "unknown_skills": bad_s,
                },
                ensure_ascii=False,
            )

    # Apply updates to existing config (exclude computed `name` — not a YAML field)
    try:
        if updates:
            updated_config = existing_config.model_dump(mode="python", exclude={"name"})
            updated_config.update(updates)
            save_agent_config(agent_code, updated_config)
        if soul is not None:
            cfg_repo.save_agent_soul(agent_code, str(soul))
        updated_field_names = list(updates.keys())
        if soul is not None:
            updated_field_names.append("soul")
        logger.info(f"Updated agent '{agent_code}' with fields: {updated_field_names}")

        return json.dumps(
            {
                "success": True,
                "agent_code": agent_code,
                "updated_fields": updated_field_names,
                "message": f"Agent '{agent_code}' updated successfully. Updated fields: {', '.join(updated_field_names)}",
            },
            ensure_ascii=False,
        )
    except Exception as e:
        logger.error(f"Failed to update agent '{agent_code}': {str(e)}")
        return json.dumps({"success": False, "error": f"Failed to update agent: {str(e)}"}, ensure_ascii=False)
