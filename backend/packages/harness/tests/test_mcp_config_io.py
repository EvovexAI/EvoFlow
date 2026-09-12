"""Tests for IDE mcp.json format parsing."""

from __future__ import annotations

from evoflow.mcp.config_io import (
    is_bogus_mcp_server_map,
    unwrap_mcp_servers_dict,
)


def test_unwrap_cursor_mcp_servers_format() -> None:
    raw = {
        "mcpServers": {
            "word-document-server": {
                "command": "python",
                "args": ["/path/word_mcp_server.py"],
            },
            "notion": {
                "url": "https://mcp.notion.com/mcp",
                "headers": {},
            },
        }
    }
    out = unwrap_mcp_servers_dict(raw)
    assert set(out.keys()) == {"word-document-server", "notion"}
    assert out["word-document-server"]["command"] == "python"
    assert out["notion"]["url"].startswith("https://")


def test_unwrap_flat_server_map() -> None:
    flat = {
        "github": {"command": "npx", "args": ["-y", "pkg"]},
    }
    assert unwrap_mcp_servers_dict(flat) == flat


def test_detect_bogus_sqlite_wrapper() -> None:
    assert is_bogus_mcp_server_map({"mcpServers": {"a": {"command": "npx"}}})
    assert not is_bogus_mcp_server_map({"a": {"command": "npx"}})
