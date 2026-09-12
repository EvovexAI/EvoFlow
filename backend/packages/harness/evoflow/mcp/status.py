"""MCP runtime status snapshot for Gateway APIs (read-only, never triggers init)."""

from __future__ import annotations

from typing import Any

from evoflow.mcp.cache import (
    get_mcp_server_load_status,
    mcp_cache_config_mtime,
    mcp_cache_initialized,
    mcp_init_error,
    peek_cached_mcp_tools,
)
from evoflow.mcp.tools import load_mcp_config, mcp_config_fingerprint


def _infer_mcp_transport(cfg: dict[str, Any]) -> str:
    """Resolve display transport: prefer explicit type, then URL heuristics, else stdio."""
    explicit = str(cfg.get("type") or cfg.get("transport") or "").strip().lower()
    if explicit in {"stdio", "sse", "http", "streamable_http", "streamable-http"}:
        if explicit in {"streamable_http", "streamable-http"}:
            return "http"
        return explicit
    url = str(cfg.get("url") or "").strip()
    if url:
        return "sse" if url.rstrip("/").endswith("/sse") else "http"
    return "stdio"


def mcp_config_stale() -> bool:
    """True when MCP config changed since last cache build."""
    if not mcp_cache_initialized():
        return False
    cached = mcp_cache_config_mtime()
    if not cached:
        return False
    return mcp_config_fingerprint() != cached


def build_mcp_status_snapshot(
    *,
    raw_servers: dict[str, Any] | None = None,
    server_names: list[str] | None = None,
) -> dict[str, Any]:
    """Runtime MCP status for main client + observability (peek cache only)."""
    from evoflow.mcp.tools import _get_mcp_config_path

    config_path = _get_mcp_config_path()
    if raw_servers is None:
        raw_servers = load_mcp_config()
    if server_names is not None:
        allowed = {str(n).strip() for n in server_names if str(n).strip()}
        raw_servers = {k: v for k, v in raw_servers.items() if k in allowed}

    cache_initialized = mcp_cache_initialized()
    tools = peek_cached_mcp_tools()
    server_load_status = get_mcp_server_load_status()
    config_stale = mcp_config_stale()

    tools_by_server: dict[str, list[dict[str, str]]] = {}
    for tool in tools:
        parts = tool.name.split("__", 1)
        if len(parts) == 2:
            server_name, tool_name = parts[0], parts[1]
        else:
            server_name, tool_name = "unknown", tool.name

        tools_by_server.setdefault(server_name, [])
        description = ""
        if hasattr(tool, "description") and tool.description:
            description = tool.description[:200]

        tools_by_server[server_name].append({
            "name": tool_name,
            "full_name": tool.name,
            "description": description,
        })

    tool_counts: dict[str, int] = {
        name: len(items) for name, items in tools_by_server.items()
    }

    servers: list[dict[str, Any]] = []
    for name, cfg in raw_servers.items():
        enabled = cfg.get("enabled", True) is not False
        transport = _infer_mcp_transport(cfg)
        if not enabled:
            load_status = "disabled"
            error: str | None = None
        elif not cache_initialized:
            load_status = "pending"
            error = None
        else:
            st = server_load_status.get(name) or {}
            load_status = str(st.get("load_status") or "error")
            error = st.get("error")
            if load_status == "error" and not error:
                error = "Failed to connect or load tools"

        server_info: dict[str, Any] = {
            "name": name,
            "enabled": enabled,
            "transport": transport,
            "load_status": load_status,
            "error": error,
            "tool_count": tool_counts.get(name, 0),
            "tools": tools_by_server.get(name, []),
        }
        if transport == "stdio":
            server_info["command"] = cfg.get("command", "")
            server_info["args"] = cfg.get("args", [])
        else:
            server_info["url"] = cfg.get("url", "")
        servers.append(server_info)

    return {
        "config_path": str(config_path),
        "config_exists": bool(raw_servers) or config_path.exists(),
        "config_stale": config_stale,
        "cache_initialized": cache_initialized,
        "init_error": mcp_init_error(),
        "total_tools": len(tools),
        "tool_counts": tool_counts,
        "servers": servers,
    }
