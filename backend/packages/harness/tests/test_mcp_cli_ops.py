"""Tests for MCP CLI ops (list/test/login)."""

from __future__ import annotations

from unittest.mock import patch

from evoflow.mcp.cli_ops import mcp_list_servers


def test_mcp_list_servers_shape() -> None:
    fake_cfg = {"Playwright": {"enabled": True, "command": "npx"}}
    fake_snap = {
        "config_path": "/tmp/mcp.json",
        "total_tools": 3,
        "cache_initialized": True,
        "init_error": None,
        "servers": [
            {
                "name": "Playwright",
                "enabled": True,
                "transport": "stdio",
                "load_status": "ready",
                "tool_count": 3,
                "error": None,
            }
        ],
    }
    with patch("evoflow.mcp.cli_ops.load_mcp_config", return_value=fake_cfg):
        with patch("evoflow.mcp.cli_ops.build_mcp_status_snapshot", return_value=fake_snap):
            out = mcp_list_servers()
    assert out["total_tools"] == 3
    assert len(out["servers"]) == 1
    assert out["servers"][0]["name"] == "Playwright"
    assert out["servers"][0]["tool_count"] == 3
