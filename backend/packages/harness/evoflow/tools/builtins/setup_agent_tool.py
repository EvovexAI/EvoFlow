import logging

from langchain_core.messages import ToolMessage
from langchain_core.tools import tool
from langgraph.prebuilt import ToolRuntime
from langgraph.types import Command

from evoflow.config.agents_config import save_agent_config, save_agent_soul
from evoflow.persistence import config_repositories as cfg_repo

logger = logging.getLogger(__name__)


@tool
def setup_agent(
    soul: str,
    description: str,
    runtime: ToolRuntime,
    tags: list[str] | None = None,
) -> Command:
    """Setup the custom EvoFlow agent.

    Args:
        soul: Full SOUL.md content defining the agent's personality and behavior.
        description: One-line description of what the agent does.
        tags: Optional tag labels for grouping/filtering (e.g. ["核心", "代码"]). Omit to infer tags automatically.
    """

    agent_name: str | None = runtime.context.get("agent_name") if runtime.context else None

    try:
        if agent_name:
            code = str(agent_name).strip().lower()
            config_data: dict = {
                "agent_code": code,
                "agent_type": "custom",
            }
            if description:
                config_data["description"] = description
            # Tags: when supplied, normalize and persist; otherwise save_agent_config
            # infers tags from the agent_code/agent_type via infer_tags_for_agent.
            if tags is not None:
                from evoflow.config.agent_tags import normalize_tags

                config_data["tags"] = normalize_tags(tags)
            save_agent_config(code, config_data)
            save_agent_soul(code, soul)
            logger.info("[agent_creator] Created agent '%s' in SQLite", code)
        return Command(
            update={
                "created_agent_name": agent_name,
                "messages": [ToolMessage(content=f"Agent '{agent_name}' created successfully!", tool_call_id=runtime.tool_call_id)],
            }
        )

    except Exception as e:
        if agent_name:
            try:
                cfg_repo.delete_agent(str(agent_name).strip().lower())
            except Exception:
                pass
        logger.error(f"[agent_creator] Failed to create agent '{agent_name}': {e}", exc_info=True)
        return Command(update={"messages": [ToolMessage(content=f"Error: {e}", tool_call_id=runtime.tool_call_id)]})
