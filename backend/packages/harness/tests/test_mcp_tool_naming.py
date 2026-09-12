"""Tests for MCP tool name normalization."""

from __future__ import annotations

from types import SimpleNamespace

from evoflow.mcp.tools import _normalize_mcp_tool_names


def test_normalize_mcp_tool_names_double_underscore_format() -> None:
    tools = [SimpleNamespace(name="Playwright_click")]
    _normalize_mcp_tool_names(tools, {"Playwright": {}})
    assert tools[0].name == "mcp__Playwright__click"

    tools2 = [SimpleNamespace(name="Playwright__navigate")]
    _normalize_mcp_tool_names(tools2, {"Playwright": {}})
    assert tools2[0].name == "mcp__Playwright__navigate"
