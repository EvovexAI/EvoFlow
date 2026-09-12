"""Per-skill / per-tool context token estimates (same path as model-bind overhead).

Skills: token cost of each ``<skill>…</skill>`` catalog entry injected into the
system prompt (progressive disclosure — not full SKILL.md).

Tools: token cost of each OpenAI wire ``tools[]`` function schema bound on the
model request.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from typing import Any

from evoflow.context.compaction_token_utils import count_text_tokens
from evoflow.context.model_request_token_estimate import wire_openai_tool_spec

logger = logging.getLogger(__name__)


def _skill_catalog_xml_item(
    skill: Any,
    *,
    use_virtual_paths: bool = False,
    compact: bool = False,
) -> str:
    """Match ``lead_agent.prompt._build_skills_prompt_section`` item markup."""
    from evoflow.agents.lead_agent.prompt import _truncate_skill_description
    from evoflow.skills.skill_uri import SKILL_URI_PREFIX

    try:
        from evoflow.config import get_app_config

        container_base_path = get_app_config().skills.container_path
    except Exception:
        container_base_path = "/mnt/skills"

    name = str(getattr(skill, "name", "") or "").strip()
    desc = str(getattr(skill, "description", "") or "")
    if compact:
        desc = _truncate_skill_description(desc)
    if use_virtual_paths:
        try:
            location = skill.get_container_file_path(container_base_path)
        except Exception:
            location = f"{container_base_path}/{name}/SKILL.md"
    else:
        location = f"{SKILL_URI_PREFIX}{name}"
    return (
        f"    <skill>\n"
        f"        <name>{name}</name>\n"
        f"        <description>{desc}</description>\n"
        f"        <location>{location}</location>\n"
        f"    </skill>"
    )


def estimate_named_skills_tokens(
    skill_names: Sequence[str],
    *,
    model: str | None = None,
    compact: bool = False,
    use_virtual_paths: bool = False,
) -> list[dict[str, Any]]:
    """Return ``[{name, tokens, status}]`` for skill catalog entries in context."""
    from evoflow.skills.loader import load_skills

    wanted = [str(n or "").strip() for n in skill_names if str(n or "").strip()]
    if not wanted:
        return []

    by_name: dict[str, Any] = {}
    try:
        for skill in load_skills(enabled_only=False):
            name = str(getattr(skill, "name", "") or "").strip()
            if name:
                by_name[name] = skill
    except Exception:
        logger.debug("load_skills failed for capability token estimate", exc_info=True)

    out: list[dict[str, Any]] = []
    for name in wanted:
        skill = by_name.get(name)
        if skill is None:
            out.append({"name": name, "tokens": None, "status": "missing"})
            continue
        try:
            xml = _skill_catalog_xml_item(
                skill,
                use_virtual_paths=use_virtual_paths,
                compact=compact,
            )
            tokens = count_text_tokens(xml, model=model)
            out.append({"name": name, "tokens": int(tokens), "status": "ok"})
        except Exception:
            logger.debug("skill token estimate failed name=%s", name, exc_info=True)
            out.append({"name": name, "tokens": None, "status": "error"})
    return out


def estimate_named_tools_tokens(
    tool_names: Sequence[str],
    *,
    model: str | None = None,
) -> list[dict[str, Any]]:
    """Return ``[{name, tokens, status}]`` for bound tool wire schemas."""
    from evoflow.tools.tool_aliases import canonical_tool_name
    from evoflow.tools.tools import get_available_tools

    wanted = [str(n or "").strip() for n in tool_names if str(n or "").strip()]
    if not wanted:
        return []

    by_name: dict[str, Any] = {}
    try:
        for tool in get_available_tools(
            include_mcp=True,
            include_search=True,
            subagent_enabled=True,
            model_name=model,
        ):
            name = str(getattr(tool, "name", "") or "").strip()
            if name and name not in by_name:
                by_name[name] = tool
    except Exception:
        logger.debug("get_available_tools failed for capability token estimate", exc_info=True)

    out: list[dict[str, Any]] = []
    for name in wanted:
        tool = by_name.get(name) or by_name.get(canonical_tool_name(name))
        if tool is None:
            out.append({"name": name, "tokens": None, "status": "missing"})
            continue
        try:
            spec = wire_openai_tool_spec(tool)
            if not isinstance(spec, dict) or not spec:
                out.append({"name": name, "tokens": None, "status": "error"})
                continue
            blob = json.dumps(spec, ensure_ascii=False, separators=(",", ":"), default=str)
            tokens = count_text_tokens(blob, model=model)
            out.append({"name": name, "tokens": int(tokens), "status": "ok"})
        except Exception:
            logger.debug("tool token estimate failed name=%s", name, exc_info=True)
            out.append({"name": name, "tokens": None, "status": "error"})
    return out


def estimate_capability_context_tokens(
    *,
    skills: Sequence[str] | None = None,
    tools: Sequence[str] | None = None,
    model: str | None = None,
    compact: bool = False,
    use_virtual_paths: bool = False,
) -> dict[str, Any]:
    skill_rows = estimate_named_skills_tokens(
        skills or [],
        model=model,
        compact=compact,
        use_virtual_paths=use_virtual_paths,
    )
    tool_rows = estimate_named_tools_tokens(tools or [], model=model)
    skills_total = sum(int(r["tokens"]) for r in skill_rows if isinstance(r.get("tokens"), int))
    tools_total = sum(int(r["tokens"]) for r in tool_rows if isinstance(r.get("tokens"), int))
    return {
        "skills": skill_rows,
        "tools": tool_rows,
        "skills_total": skills_total,
        "tools_total": tools_total,
        "model": model or "",
    }
