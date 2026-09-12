"""MCP role binding helpers and deprecated prompt builders (native binding only)."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.mcp.tools import load_mcp_config

logger = logging.getLogger(__name__)


def resolve_mcp_server_names(
    mcp_servers: list[str] | None,
    raw_cfg: dict[str, Any],
) -> list[str]:
    """Role MCP binding: ``None`` = all enabled servers; ``[]`` = none; else explicit list."""
    if mcp_servers is None:
        return sorted(
            name for name, cfg in raw_cfg.items() if cfg.get("enabled", True) is not False
        )
    return sorted(str(s).strip() for s in mcp_servers if str(s).strip())


def mcp_prompt_fingerprint(mcp_servers: list[str] | None) -> str:
    """Fingerprint MCP *binding config* only (not load status).

    Cache-first: ``cache:pending → ready`` must not rebuild system mid-session.
    Catalog content updates on the next Dynamic rebuild triggered by other sig parts
    (e.g. new user turn).
    """
    from evoflow.mcp.tools import mcp_config_fingerprint

    try:
        raw_cfg = load_mcp_config()
    except Exception:
        return "cache:cfg_error"

    names = resolve_mcp_server_names(mcp_servers, raw_cfg)
    if not names:
        return "cache:empty_binding"

    return f"cfg:{(mcp_config_fingerprint() or '')[:12]}|names:{','.join(names)}"


def build_mcp_skill_prompt_section(mcp_servers: list[str] | None) -> str:
    """Deprecated: use :func:`evoflow.mcp.native_prompt.build_mcp_native_prompt_section`."""
    logger.warning("build_mcp_skill_prompt_section is deprecated; using native MCP prompt")
    from evoflow.mcp.native_prompt import build_mcp_native_prompt_section

    return build_mcp_native_prompt_section(mcp_servers)


def build_mcp_skill_prompt_section_safe(mcp_servers: list[str] | None) -> str:
    """Deprecated: redirects to native-style native MCP prompt."""
    from evoflow.mcp.native_prompt import build_mcp_native_prompt_section_safe

    return build_mcp_native_prompt_section_safe(mcp_servers)
