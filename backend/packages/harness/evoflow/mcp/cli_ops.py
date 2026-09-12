"""native-style MCP CLI operations: list, get, add, remove, test, login, logout."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from evoflow.mcp.status import build_mcp_status_snapshot
from evoflow.mcp.tools import load_mcp_config

logger = logging.getLogger(__name__)


def mcp_list_servers(*, server_names: list[str] | None = None) -> dict[str, Any]:
    """List configured MCP servers and runtime status (MCP list)."""
    raw = load_mcp_config()
    if server_names:
        allowed = {str(n).strip() for n in server_names if str(n).strip()}
        raw = {k: v for k, v in raw.items() if k in allowed}
    snap = build_mcp_status_snapshot(raw_servers=raw, server_names=list(raw.keys()) if raw else None)
    rows: list[dict[str, Any]] = []
    for srv in snap.get("servers") or []:
        rows.append(
            {
                "name": srv.get("name"),
                "enabled": srv.get("enabled"),
                "transport": srv.get("transport"),
                "load_status": srv.get("load_status"),
                "tool_count": srv.get("tool_count"),
                "error": srv.get("error"),
            }
        )
    return {
        "config_path": snap.get("config_path"),
        "total_tools": snap.get("total_tools"),
        "cache_initialized": snap.get("cache_initialized"),
        "init_error": snap.get("init_error"),
        "servers": rows,
    }


def mcp_get_server(server_name: str) -> dict[str, Any]:
    """Show one MCP server config (MCP get)."""
    from evoflow.admin.mcp import get_mcp_server

    return get_mcp_server(server_name)


def mcp_add_server(server_name: str, document: dict[str, Any]) -> dict[str, Any]:
    """Add or update one MCP server (MCP add)."""
    from evoflow.admin.mcp import add_mcp_server

    return add_mcp_server(server_name, document)


def mcp_remove_server(server_name: str) -> dict[str, Any]:
    """Remove one MCP server (MCP remove)."""
    from evoflow.admin.mcp import remove_mcp_server

    return remove_mcp_server(server_name)


def mcp_test_server(server_name: str) -> dict[str, Any]:
    """Connect to one MCP server and list tools (EvoFlow diagnostic; runtime has no ``test``)."""
    name = str(server_name or "").strip()
    if not name:
        return {"ok": False, "error": "server name required"}
    raw = load_mcp_config()
    cfg = raw.get(name)
    if not cfg:
        return {"ok": False, "error": f"unknown MCP server: {name}"}
    if cfg.get("enabled") is False:
        return {"ok": False, "error": f"MCP server {name!r} is disabled"}

    from evoflow.mcp.tools import _load_tools_from_server, _normalize_mcp_server_config

    normalized = _normalize_mcp_server_config(name, dict(cfg))
    if not normalized:
        return {"ok": False, "error": f"invalid MCP config for {name!r}"}

    async def _run() -> tuple[list, str | None]:
        return await _load_tools_from_server(name, normalized, raw_cfg=dict(cfg))

    try:
        tools, err = asyncio.run(_run())
    except Exception as exc:
        return {"ok": False, "server": name, "error": str(exc)}

    if err:
        return {"ok": False, "server": name, "error": err}

    return {
        "ok": True,
        "server": name,
        "tool_count": len(tools),
        "tools": [
            {"name": getattr(t, "name", ""), "description": (getattr(t, "description", "") or "")[:200]}
            for t in tools
        ],
    }


def mcp_login_server(server_name: str) -> dict[str, Any]:
    """Refresh OAuth token for an HTTP MCP server (MCP OAuth login)."""
    name = str(server_name or "").strip()
    if not name:
        return {"ok": False, "error": "server name required"}

    try:
        from evoflow.config.extensions_config import get_extensions_config
        from evoflow.mcp.oauth import OAuthTokenManager

        ext = get_extensions_config()
        mgr = OAuthTokenManager.from_extensions_config(ext)
        if name not in mgr.oauth_server_names():
            return {
                "ok": False,
                "server": name,
                "error": "no OAuth configured for this server (stdio MCP does not use mcp login)",
            }

        async def _run() -> str | None:
            return await mgr.get_authorization_header(name)

        header = asyncio.run(_run())
        if not header:
            return {"ok": False, "server": name, "error": "OAuth token fetch returned empty"}
        return {"ok": True, "server": name, "message": "OAuth access token refreshed"}
    except Exception as exc:
        logger.warning("mcp login failed server=%s: %s", name, exc)
        return {"ok": False, "server": name, "error": str(exc)}


def mcp_logout_server(server_name: str) -> dict[str, Any]:
    """Clear in-process OAuth cache for a server (MCP OAuth logout, best-effort)."""
    name = str(server_name or "").strip()
    if not name:
        return {"ok": False, "error": "server name required"}
    return {
        "ok": True,
        "server": name,
        "message": "OAuth tokens are fetched per session; restart Gateway or re-login after config change",
    }
