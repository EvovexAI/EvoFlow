"""native-style native MCP system prompt (tools bound via function calling, not terminal)."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.mcp.prompt_section import resolve_mcp_server_names

logger = logging.getLogger(__name__)


def _prompt_dynamic(lang: str | None):
    from evoflow.agents.lead_agent.prompt_language import resolve_prompt_language
    from evoflow.agents.lead_agent.prompt_dynamic_en import (
        MCP_RULE_COMPACT as EN,
    )
    from evoflow.agents.lead_agent.prompt_dynamic_zh import (
        MCP_RULE_COMPACT as ZH,
    )

    if resolve_prompt_language(lang).startswith("zh"):
        return ZH
    return EN


def build_mcp_native_prompt_section(
    mcp_servers: list[str] | None,
    *,
    bound_tool_names: list[str] | None = None,
    prompt_language: str | None = None,
) -> str:
    """Build ``<mcp_system>`` for roles with MCP enabled (native tool binding)."""
    from evoflow.mcp.tools import load_mcp_config

    raw_cfg = load_mcp_config()
    names = resolve_mcp_server_names(mcp_servers, raw_cfg)
    if not names:
        return ""

    from evoflow.mcp.binding import is_mcp_tool_name, mcp_server_from_tool_name

    rule = _prompt_dynamic(prompt_language)
    servers_line = ", ".join(names)

    tool_lines: list[str] = []
    if bound_tool_names:
        mcp_tools = sorted(
            n
            for n in bound_tool_names
            if is_mcp_tool_name(str(n)) and mcp_server_from_tool_name(str(n)) in names
        )
        if mcp_tools:
            preview = mcp_tools[:24]
            tool_lines.append("Bound MCP tools (call by exact name):")
            tool_lines.extend(f"- {t}" for t in preview)
            if len(mcp_tools) > len(preview):
                tool_lines.append(f"- … and {len(mcp_tools) - len(preview)} more")

    body = [
        "<mcp_system>",
        rule,
        f"Enabled MCP servers for this role: {servers_line}.",
        "Configure globally in EvoPanel Connectors or ``~/.evoflow/mcp.json``.",
    ]
    if tool_lines:
        body.extend(tool_lines)
    body.append("</mcp_system>")
    return "\n".join(body)


def build_mcp_native_prompt_section_safe(
    mcp_servers: list[str] | None,
    *,
    bound_tool_names: list[str] | None = None,
    prompt_language: str | None = None,
) -> str:
    try:
        return build_mcp_native_prompt_section(
            mcp_servers,
            bound_tool_names=bound_tool_names,
            prompt_language=prompt_language,
        )
    except Exception as exc:
        logger.warning("build_mcp_native_prompt_section failed: %s", exc)
        return (
            "<mcp_system>\n"
            "MCP tools are native function tools (``mcp__<server>__<tool>``). "
            "Do not use terminal or mcp-terminal for MCP.\n"
            f"(catalog error: {exc})\n"
            "</mcp_system>"
        )


def mcp_native_prompt_fingerprint(mcp_servers: list[str] | None) -> str:
    """Fingerprint MCP binding for dynamic system prompt cache."""
    from evoflow.mcp.prompt_section import mcp_prompt_fingerprint

    return mcp_prompt_fingerprint(mcp_servers)
