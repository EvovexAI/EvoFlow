"""MCP configuration admin (extensions_config + SQLite)."""

from __future__ import annotations

from typing import Any

from evoflow.config.extensions_config import get_extensions_config, reload_extensions_config
from evoflow.persistence import config_repositories as cfg_repo


def _reload_mcp_runtime() -> None:
    """Reload extensions singleton and warm MCP tool cache (native-style hot reload)."""
    reload_extensions_config()
    try:
        from evoflow.mcp.cache import reset_mcp_tools_cache

        reset_mcp_tools_cache()
    except Exception:
        pass


def get_mcp_config() -> dict[str, Any]:
    config = get_extensions_config()
    return {"mcp_servers": {name: server.model_dump() for name, server in config.mcp_servers.items()}}


def get_mcp_server(name: str) -> dict[str, Any]:
    from evoflow.admin.errors import NotFoundError

    key = str(name or "").strip()
    if not key:
        from evoflow.admin.errors import ValidationError

        raise ValidationError("server name required")
    config = get_extensions_config()
    server = config.mcp_servers.get(key)
    if server is None:
        raise NotFoundError(f"MCP server not found: {key}")
    return {"name": key, "config": server.model_dump()}


def set_mcp_config(data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        from evoflow.admin.errors import ValidationError

        raise ValidationError("MCP payload must be a JSON object")
    servers = data.get("mcp_servers", data)
    if not isinstance(servers, dict):
        from evoflow.admin.errors import ValidationError

        raise ValidationError("Expected mcp_servers object")
    cfg_repo.replace_mcp_servers(servers)
    _reload_mcp_runtime()
    reloaded = get_extensions_config()
    return {"mcp_servers": {name: server.model_dump() for name, server in reloaded.mcp_servers.items()}}


def add_mcp_server(name: str, document: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin.errors import ValidationError

    key = str(name or "").strip()
    if not key:
        raise ValidationError("server name required")
    if not isinstance(document, dict):
        raise ValidationError("server config must be a JSON object")
    cfg_repo.upsert_mcp_server(key, document)
    _reload_mcp_runtime()
    return get_mcp_server(key)


def remove_mcp_server(name: str) -> dict[str, Any]:
    from evoflow.admin.errors import NotFoundError, ValidationError

    key = str(name or "").strip()
    if not key:
        raise ValidationError("server name required")
    if not cfg_repo.delete_mcp_server(key):
        raise NotFoundError(f"MCP server not found: {key}")
    _reload_mcp_runtime()
    return {"ok": True, "removed": key}
