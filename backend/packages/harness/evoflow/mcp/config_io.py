"""MCP config file I/O — 常见 IDE ``mcp.json`` format support."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_META_KEYS = frozenset({"mcpServers", "mcp_servers", "skills"})


def _looks_like_server_entry(value: Any) -> bool:
    """True when ``value`` has a usable transport endpoint (command or url).

    ``args`` alone is not enough — that would accept half-written configs like
    ``{"args": ["-y"]}`` with no executable.
    """
    if not isinstance(value, dict):
        return False
    command = str(value.get("command") or "").strip()
    url = str(value.get("url") or "").strip()
    return bool(command or url)


def unwrap_mcp_servers_dict(data: Any) -> dict[str, dict[str, Any]]:
    """Normalize composer-style payloads to ``{server_name: server_config}``.

    Accepts:
    - ``{"mcpServers": {"github": {...}}}``  (常见 IDE)
    - ``{"github": {"command": "npx", ...}}``  (flat map, EvoFlow UI)
    """
    if not isinstance(data, dict):
        return {}

    inner = data.get("mcpServers") or data.get("mcp_servers")
    if isinstance(inner, dict) and inner:
        if all(_looks_like_server_entry(v) for v in inner.values()):
            return {str(k): dict(v) for k, v in inner.items() if isinstance(v, dict)}

    # Single-key wrapper saved by mistake: entire file stored as one "mcpServers" server
    if set(data.keys()) == {"mcpServers"} and isinstance(inner, dict):
        return unwrap_mcp_servers_dict({"mcpServers": inner})

    out: dict[str, dict[str, Any]] = {}
    for key, value in data.items():
        if key in _META_KEYS:
            continue
        if isinstance(value, dict) and _looks_like_server_entry(value):
            out[str(key)] = dict(value)
    return out


def is_bogus_mcp_server_map(servers: dict[str, Any]) -> bool:
    """Detect SQLite rows that stored the whole file under the key ``mcpServers``."""
    if not servers:
        return False
    if set(servers.keys()) == {"mcpServers"}:
        return True
    only = servers.get("mcpServers")
    if isinstance(only, dict) and any(_looks_like_server_entry(v) for v in only.values()):
        return True
    return False


def resolve_mcp_json_paths() -> list[Path]:
    """Candidate ``mcp.json`` locations (first match wins when loading)."""
    paths: list[Path] = []
    env_path = (os.environ.get("EVOFLOW_MCP_CONFIG") or "").strip()
    if env_path:
        paths.append(Path(env_path).expanduser())
    try:
        from evoflow.config.data_paths import resolve_data_base_dir

        paths.append(resolve_data_base_dir() / "mcp.json")
    except Exception:
        paths.append(Path.home() / ".evoflow" / "mcp.json")
    paths.append(Path.home() / ".cursor" / "mcp.json")
    # de-dupe preserving order
    seen: set[str] = set()
    unique: list[Path] = []
    for p in paths:
        key = str(p.resolve()) if p.exists() else str(p)
        if key in seen:
            continue
        seen.add(key)
        unique.append(p)
    return unique


def load_mcp_json_from_files() -> tuple[dict[str, dict[str, Any]], Path | None]:
    """Load first available ``mcp.json`` (IDE ``mcpServers`` format supported)."""
    for path in resolve_mcp_json_paths():
        if not path.is_file():
            continue
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            servers = unwrap_mcp_servers_dict(data)
            if servers:
                logger.info("Loaded %d MCP server(s) from %s", len(servers), path)
                return servers, path
        except json.JSONDecodeError as exc:
            logger.error("Invalid JSON in MCP config %s: %s", path, exc)
        except Exception as exc:
            logger.error("Failed to read MCP config %s: %s", path, exc)
    return {}, None


def sync_mcp_servers_to_sqlite(servers: dict[str, dict[str, Any]]) -> None:
    from evoflow.persistence import config_repositories as cfg_repo

    cfg_repo.replace_mcp_servers(servers)
    try:
        from evoflow.config.extensions_config import reload_extensions_config

        reload_extensions_config()
    except Exception:
        logger.debug("extensions config reload after MCP sync skipped", exc_info=True)
