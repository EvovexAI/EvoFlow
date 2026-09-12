"""runtime-aligned MCP binding: native LangChain tools only (no skill/terminal path)."""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

_LEGACY_SKILL_ENV = "EVOFLOW_MCP_TOOL_BINDING"
MCP_TOOL_PREFIX = "mcp"
MCP_TOOL_DELIMITER = "__"


def warn_if_legacy_mcp_skill_binding_env() -> None:
    """Log once per process if legacy skill-injection env is set (ignored)."""
    raw = os.environ.get(_LEGACY_SKILL_ENV, "").strip().lower()
    if raw and raw not in {"native", "tools", "direct"}:
        logger.warning(
            "%s=%r is deprecated and ignored; EvoFlow uses native-style native MCP tool binding only.",
            _LEGACY_SKILL_ENV,
            raw,
        )


def qualified_mcp_tool_name(server_name: str, tool_name: str) -> str:
    """native-style qualified name: ``mcp__{server}__{tool}``."""
    server = str(server_name or "").strip()
    tool = str(tool_name or "").strip()
    return f"{MCP_TOOL_PREFIX}{MCP_TOOL_DELIMITER}{server}{MCP_TOOL_DELIMITER}{tool}"


def is_mcp_tool_name(tool_name: str) -> bool:
    """True for native-style ``mcp__server__tool`` (and legacy ``server__tool``)."""
    n = str(tool_name or "").strip()
    if n.startswith(f"{MCP_TOOL_PREFIX}{MCP_TOOL_DELIMITER}"):
        rest = n[len(MCP_TOOL_PREFIX) + len(MCP_TOOL_DELIMITER) :]
        return MCP_TOOL_DELIMITER in rest
    if MCP_TOOL_DELIMITER in n and not n.startswith(f"{MCP_TOOL_PREFIX}{MCP_TOOL_DELIMITER}"):
        return True
    return False


def mcp_server_from_tool_name(tool_name: str) -> str | None:
    """Extract MCP server name from ``mcp__server__tool`` or legacy ``server__tool``."""
    n = str(tool_name or "").strip()
    prefix = f"{MCP_TOOL_PREFIX}{MCP_TOOL_DELIMITER}"
    if n.startswith(prefix):
        rest = n[len(prefix) :]
        if MCP_TOOL_DELIMITER in rest:
            return rest.split(MCP_TOOL_DELIMITER, 1)[0].strip() or None
        return None
    if MCP_TOOL_DELIMITER in n:
        return n.split(MCP_TOOL_DELIMITER, 1)[0].strip() or None
    return None


def role_has_mcp_binding(agent_config: Any | None) -> bool:
    """True when the role may use MCP tools (None = all enabled; [] = explicitly none)."""
    if agent_config is None:
        return True
    servers = getattr(agent_config, "mcp_servers", None)
    if servers is None:
        return True
    if isinstance(servers, list):
        return len(servers) > 0
    return bool(servers)


def filter_tools_by_mcp_servers(tools: list, mcp_servers: list[str] | None) -> list:
    """Filter MCP tools by role binding. ``None`` keeps all MCP tools; ``[]`` strips them."""
    if mcp_servers is None:
        return list(tools or [])
    allowed = {str(s).strip() for s in mcp_servers if str(s).strip()}
    out: list = []
    for t in tools or []:
        name = str(getattr(t, "name", "") or "").strip()
        server = mcp_server_from_tool_name(name)
        if server is None or server in allowed:
            out.append(t)
    return out


def mount_agent_mcp_tools(loaded_tools: list, all_tools: list, mcp_servers: list[str] | None) -> list:
    """When a role explicitly lists MCP servers, bind their tools directly (not deferred)."""
    if mcp_servers is None:
        return list(loaded_tools or [])
    allowed = {str(s).strip() for s in mcp_servers if str(s).strip()}
    if not allowed:
        return list(loaded_tools or [])
    loaded_names = {str(getattr(t, "name", "") or "").strip() for t in (loaded_tools or [])}
    extra: list = []
    for t in all_tools or []:
        name = str(getattr(t, "name", "") or "").strip()
        server = mcp_server_from_tool_name(name)
        if server and server in allowed and name not in loaded_names:
            extra.append(t)
    if not extra:
        return list(loaded_tools or [])
    return [*list(loaded_tools or []), *extra]
