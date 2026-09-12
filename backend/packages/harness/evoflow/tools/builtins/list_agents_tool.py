"""Tool for listing all available custom agents."""

import json
import logging
from pathlib import Path
from typing import Annotated

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT

from evoflow.config.agents_config import list_all_agents

logger = logging.getLogger(__name__)


def _configured_acp_agents_from_runtime_or_config() -> list[dict]:
    """Return ACP agents declared in runtime config or root config.yaml."""
    out: list[dict] = []
    seen: set[str] = set()
    try:
        from evoflow.config.acp_config import get_acp_agents

        for code, cfg in (get_acp_agents() or {}).items():
            k = str(code or "").strip().lower()
            if not k or k in seen:
                continue
            seen.add(k)
            out.append(
                {
                    "agent_code": k,
                    "agent_name": k,
                    "type": "acp",
                    "description": str(getattr(cfg, "description", "") or ""),
                    "model": getattr(cfg, "model", None),
                    "tools": ["invoke_acp_agent"],
                    "recommended_task_types": _infer_recommended_task_types(
                        agent_code=k,
                        agent_name=k,
                        description=str(getattr(cfg, "description", "") or ""),
                        tools=["invoke_acp_agent"],
                    ),
                    "skills": None,
                    "disallowed_tools": None,
                    "max_turns": None,
                    "timeout_seconds": None,
                }
            )
    except Exception:
        logger.debug("list_agents_tool: get_acp_agents failed", exc_info=True)

    # Fallback: parse repo-root config.yaml directly if runtime ACP config is empty.
    if out:
        return out
    try:
        cfg_path = Path(__file__).resolve().parents[6] / "config.yaml"
        import yaml

        data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
        acp_agents = data.get("acp_agents") or {}
        if isinstance(acp_agents, dict):
            for code, cfg in acp_agents.items():
                k = str(code or "").strip().lower()
                if not k or k in seen:
                    continue
                seen.add(k)
                desc = ""
                model = None
                if isinstance(cfg, dict):
                    desc = str(cfg.get("description") or "")
                    model = cfg.get("model")
                out.append(
                    {
                        "agent_code": k,
                        "agent_name": k,
                        "type": "acp",
                        "description": desc,
                        "model": model,
                        "tools": ["invoke_acp_agent"],
                        "recommended_task_types": _infer_recommended_task_types(
                            agent_code=k,
                            agent_name=k,
                            description=desc,
                            tools=["invoke_acp_agent"],
                        ),
                        "skills": None,
                        "disallowed_tools": None,
                        "max_turns": None,
                        "timeout_seconds": None,
                    }
                )
    except Exception:
        logger.debug("list_agents_tool: fallback config acp parse failed", exc_info=True)
    return out


def _infer_recommended_task_types(
    *,
    agent_code: str | None,
    agent_name: str | None,
    description: str | None,
    tools: list[str] | None,
) -> list[str]:
    text = f"{agent_code or ''} {agent_name or ''} {description or ''}".lower()
    tool_set = {str(t).strip().lower() for t in (tools or []) if str(t).strip()}
    rec: list[str] = []

    code_key = str(agent_code or "").strip().lower()
    if code_key.startswith("media-"):
        rec.extend(["creative_media", "media_production", "image_generation", "video_generation"])
    if "claude-code" in text or "claude-session" in text or "claude-code" in tool_set:
        rec.extend(["code_implementation", "code_debugging", "code_refactor", "project_engineering"])
    if any(k in text for k in ("代码", "coding", "code", "debug", "调试", "重构", "refactor")):
        rec.extend(["code_implementation", "code_debugging"])
    if any(k in text for k in ("research", "检索", "搜索", "web", "资料")):
        rec.extend(["web_research", "information_gathering"])
    if any(k in text for k in ("文档", "doc", "write", "总结", "汇总")):
        rec.extend(["documentation", "summarization"])
    if not rec:
        rec.extend(["general_task_execution"])

    # De-dup keep order
    seen: set[str] = set()
    out: list[str] = []
    for x in rec:
        if x in seen:
            continue
        seen.add(x)
        out.append(x)
    return out


# UI metadata for tool discovery (attached to function, not tool object)
list_agents_tool_ui_metadata = {"label": "查询智能体", "icon": "📋", "group": "agent_management", "description": "列出所有可用智能体及其配置信息"}


@tool("list_agents")
async def list_agents_tool(
    runtime: ToolRuntime[ContextT, dict],
    tool_call_id: Annotated[str, InjectedToolCallId],
    tags: list[str] | None = None,
    assignable_only: bool = False,
) -> str:
    """List available agents. Use ``tags`` to filter by tag labels (substring match, e.g. ["核心", "代码"]). Set ``assignable_only`` when picking workers for subtasks."""
    logger.info("list_agents_tool: listing agents tags=%s assignable_only=%s", tags, assignable_only)

    try:
        from evoflow.config.agent_tags import infer_tags_for_agent

        # Normalize the optional tag filter into a list of non-empty substrings.
        tag_filters: list[str] = []
        if tags:
            for t in tags:
                s = str(t).strip()
                if s:
                    tag_filters.append(s)

        agents = list_all_agents()

        # Convert to serializable format
        agent_list = []
        for agent in agents:
            agent_tags = list(getattr(agent, "tags", []) or [])
            if not agent_tags and agent.agent_code != "main":
                agent_tags = infer_tags_for_agent(agent_code=agent.agent_code, agent_type=agent.agent_type)
            agent_dict = {
                "agent_code": agent.agent_code,
                "agent_name": agent.agent_name,
                "type": agent.agent_type,
                "tags": agent_tags,
                "description": agent.description,
                "model": agent.model,
                "tools": agent.tools,
                "recommended_task_types": _infer_recommended_task_types(
                    agent_code=agent.agent_code,
                    agent_name=agent.agent_name,
                    description=agent.description,
                    tools=agent.tools if isinstance(agent.tools, list) else None,
                ),
                "skills": agent.skills,
                "disallowed_tools": agent.disallowed_tools,
                "max_turns": agent.max_turns,
                "timeout_seconds": agent.timeout_seconds,
            }
            agent_list.append(agent_dict)
        for acp in _configured_acp_agents_from_runtime_or_config():
            acp_code = str(acp.get("agent_code") or "").strip().lower()
            if not acp_code:
                continue
            if not any(str(x.get("agent_code") or "").strip().lower() == acp_code for x in agent_list):
                acp["tags"] = infer_tags_for_agent(agent_code=acp_code, agent_type="acp")
                agent_list.append(acp)

        if assignable_only:
            agent_list = [
                a
                for a in agent_list
                if str(a.get("type") or "").strip().lower() in {"subagent", "acp", "builtin"}
                and str(a.get("agent_code") or "").strip().lower()
                not in {"claude-code", "claude-session", "claude"}
            ]

        if tag_filters:
            agent_list = [
                a
                for a in agent_list
                if any(
                    any(wanted in (t or "") for t in (a.get("tags") or []))
                    for wanted in tag_filters
                )
            ]

        agent_list = [
            a
            for a in agent_list
            if str(a.get("agent_code") or "").strip().lower()
            not in {"claude-code", "claude-session", "claude"}
        ]

        payload: dict = {
            "success": True,
            "agents": agent_list,
            "count": len(agent_list),
            "message": (
                f"Found {len(agent_list)} agent(s) matching tags {tag_filters}."
                if tag_filters
                else f"Found {len(agent_list)} agent(s). Use the 'agent_code' field for assigned_agent when creating subtasks."
            ),
        }

        logger.info(f"Listed {len(agent_list)} agents")

        return json.dumps(payload, ensure_ascii=False, default=str)
    except Exception as e:
        logger.error(f"Failed to list agents: {str(e)}")
        return json.dumps({"success": False, "error": f"Failed to list agents: {str(e)}"}, ensure_ascii=False)
