"""Tool for creating new custom agents."""

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
create_agent_tool_ui_metadata = {"label": "创建智能体", "icon": "🤖", "group": "agent_management", "description": "创建新的自定义智能体，支持中文名、工具/技能配置"}


@tool("create_agent")
async def create_agent_tool(
    runtime: ToolRuntime[ContextT, dict],
    tool_call_id: Annotated[str, InjectedToolCallId],
    agent_code: str,
    agent_name: str | None = None,
    agent_type: str = "subagent",
    description: str = "",
    model: str | None = None,
    system_prompt: str | None = None,
    tools: list[str] | str | None = None,
    skills: list[str] | str | None = None,
    mcp_servers: list[str] | str | None = None,
    disallowed_tools: list[str] | str | None = None,
    max_turns: int = 500,
    timeout_seconds: int = 900,
    soul: str | None = None,
    tags: list[str] | None = None,
) -> str:
    """Create a new custom agent.

    Omit ``model`` — execution uses the session default chat model. Pass ``model`` only if the user explicitly asks to pin a different model for this agent.

    ``soul`` writes ``agents/<agent_code>/SOUL.md`` (persona / guardrails). Omit to leave SOUL unset until the user edits in EvoPanel or calls ``update_agent``.

    ``tags`` assigns optional tag labels for grouping/filtering (e.g. ["核心", "代码"]). Omit to infer tags automatically from the agent code/type.
    """
    # Normalize agent code
    agent_code = agent_code.strip().lower()

    logger.info(
        "create_agent_tool: agent_code=%s agent_name=%s agent_type=%s",
        agent_code,
        agent_name,
        agent_type,
    )

    # Validate agent code format
    import re

    if not re.match(r"^[A-Za-z0-9-]+$", agent_code):
        return json.dumps({"success": False, "error": f"Invalid agent code '{agent_code}'. Must contain only letters, numbers, and hyphens."}, ensure_ascii=False)

    tools = normalize_str_or_list_argument(tools)
    skills = normalize_str_or_list_argument(skills)
    mcp_servers = normalize_str_or_list_argument(mcp_servers)
    disallowed_tools = normalize_str_or_list_argument(disallowed_tools)

    # Subagent: need behavioral spec as system_prompt and/or soul (SOUL.md)
    sp_ok = bool((system_prompt or "").strip())
    soul_ok = soul is not None and str(soul).strip()
    if agent_type == "subagent" and not sp_ok and not soul_ok:
        return json.dumps(
            {
                "success": False,
                "error": "For subagent type, provide system_prompt and/or soul (persona in SOUL.md).",
            },
            ensure_ascii=False,
        )

    # Check if agent already exists
    try:
        existing = load_agent_config(agent_code)
        if existing:
            return json.dumps({"success": False, "error": f"Agent '{agent_code}' already exists. Use update_agent to modify it."}, ensure_ascii=False)
    except FileNotFoundError:
        pass  # Expected - agent doesn't exist yet

    mn = model_name_from_tool_runtime(runtime)
    if tools is not None:
        _, unknown_tools = partition_tool_names(tools, model_name=mn)
        if unknown_tools:
            return json.dumps(
                {
                    "success": False,
                    "error": f"Unknown tool names (not in runtime catalog): {unknown_tools}. Call list_assignable_tools first.",
                    "unknown_tools": unknown_tools,
                },
                ensure_ascii=False,
            )
    if disallowed_tools is not None:
        _, unknown_dis = partition_tool_names(disallowed_tools, model_name=mn)
        if unknown_dis:
            return json.dumps(
                {
                    "success": False,
                    "error": f"Unknown disallowed_tools names: {unknown_dis}. Call list_assignable_tools first.",
                    "unknown_disallowed_tools": unknown_dis,
                },
                ensure_ascii=False,
            )
    if skills is not None:
        _, unknown_sk = partition_skill_names(skills, enabled_only=True)
        if unknown_sk:
            return json.dumps(
                {
                    "success": False,
                    "error": f"Unknown skill names (not in enabled skills catalog): {unknown_sk}. Call list_skills_catalog first.",
                    "unknown_skills": unknown_sk,
                },
                ensure_ascii=False,
            )

    # Build agent config (omit tools/skills/disallowed_tools/model when unset so YAML matches AgentConfig defaults)
    agent_config: dict = {
        "agent_code": agent_code,
        "agent_name": agent_name,
        "agent_type": agent_type,
        "description": description,
        "system_prompt": system_prompt,
        "max_turns": max_turns,
        "timeout_seconds": timeout_seconds,
    }
    if model is not None:
        agent_config["model"] = model
    if tools is not None:
        agent_config["tools"] = tools
    if skills is not None:
        agent_config["skills"] = skills
    if mcp_servers is not None:
        agent_config["mcp_servers"] = mcp_servers
    if disallowed_tools is not None:
        agent_config["disallowed_tools"] = disallowed_tools

    # Tags: when supplied, normalize and persist; otherwise save_agent_config
    # infers tags from the agent_code/agent_type via infer_tags_for_agent.
    if tags is not None:
        from evoflow.config.agent_tags import normalize_tags

        agent_config["tags"] = normalize_tags(tags)

    # Default gallery cutout when the tool does not set an avatar.
    if not agent_config.get("avatar"):
        from evoflow.config.avatar_presets import pick_random_preset_avatar

        random_avatar = pick_random_preset_avatar()
        if random_avatar:
            agent_config["avatar"] = random_avatar

    # Save agent configuration
    try:
        save_agent_config(agent_code, agent_config)
        if soul is not None:
            cfg_repo.save_agent_soul(agent_code, str(soul))
        logger.info(f"Created agent '{agent_code}' successfully")

        # Read back the persisted config so tags (possibly inferred) are accurate.
        try:
            from evoflow.config.agents_config import load_agent_config as _load_created

            created_cfg = _load_created(agent_code)
            created_tags = list(getattr(created_cfg, "tags", []) or []) if created_cfg else list(agent_config.get("tags") or [])
        except Exception:
            created_tags = list(agent_config.get("tags") or [])

        return json.dumps(
            {
                "success": True,
                "agent_code": agent_code,
                "agent_name": agent_name,
                "agent_type": agent_type,
                "tags": created_tags,
                "description": description,
                "message": f"Agent '{agent_code}' created successfully (tags={created_tags}). You can now use it by specifying assigned_agent='{agent_code}' when creating subtasks.",
            },
            ensure_ascii=False,
        )
    except Exception as e:
        logger.error(f"Failed to create agent '{agent_code}': {str(e)}")
        return json.dumps({"success": False, "error": f"Failed to create agent: {str(e)}"}, ensure_ascii=False)
