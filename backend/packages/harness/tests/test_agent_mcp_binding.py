"""Role MCP server binding → tool mount and prompt sections."""

from __future__ import annotations

from types import SimpleNamespace

from evoflow.agents.lead_agent.agent import (
    _filter_tools_by_mcp_servers,
    _mcp_server_from_tool_name,
    _mount_agent_mcp_tools,
)
from evoflow.agents.lead_agent.prompt import get_loaded_tools_prompt_section


def _tool(name: str):
    return SimpleNamespace(name=name)


def test_mcp_server_from_tool_name() -> None:
    assert _mcp_server_from_tool_name("mcp__Playwright__click") == "Playwright"
    assert _mcp_server_from_tool_name("read") is None


def test_filter_tools_by_mcp_servers_none_keeps_all() -> None:
    tools = [_tool("read"), _tool("mcp__Playwright__a"), _tool("mcp__lark-mcp__b")]
    out = _filter_tools_by_mcp_servers(tools, None)
    assert [t.name for t in out] == ["read", "mcp__Playwright__a", "mcp__lark-mcp__b"]


def test_filter_tools_by_mcp_servers_explicit_list() -> None:
    tools = [_tool("read"), _tool("mcp__Playwright__a"), _tool("mcp__lark-mcp__b")]
    out = _filter_tools_by_mcp_servers(tools, ["Playwright"])
    assert [t.name for t in out] == ["read", "mcp__Playwright__a"]


def test_filter_tools_by_mcp_servers_empty_list_drops_mcp() -> None:
    tools = [_tool("read"), _tool("mcp__Playwright__a")]
    out = _filter_tools_by_mcp_servers(tools, [])
    assert [t.name for t in out] == ["read"]


def test_mount_agent_mcp_tools_when_role_bound() -> None:
    loaded = [_tool("read"), _tool("tool_search")]
    all_tools = loaded + [_tool("mcp__Playwright__click"), _tool("mcp__lark-mcp__send")]
    bound = ["Playwright"]
    filtered_all = _filter_tools_by_mcp_servers(all_tools, bound)
    mounted = _mount_agent_mcp_tools(loaded, filtered_all, bound)
    names = [t.name for t in mounted]
    assert "read" in names
    assert "mcp__Playwright__click" in names
    assert "mcp__lark-mcp__send" not in names


def test_mount_agent_mcp_tools_none_defers() -> None:
    loaded = [_tool("read")]
    all_tools = loaded + [_tool("mcp__Playwright__click")]
    mounted = _mount_agent_mcp_tools(loaded, all_tools, None)
    assert [t.name for t in mounted] == ["read"]


def test_loaded_tools_prompt_section_omitted_from_system_prompt() -> None:
    from evoflow.agents.lead_agent.prompt import _build_tool_catalog_section

    assert get_loaded_tools_prompt_section(["read", "mcp__Playwright__click", "tool_search"]) == ""
    section = _build_tool_catalog_section(
        ["read", "tool_search", "scenario"],
        active_scenarios=["agent"],
    )
    assert "<available-tools>" not in section
    assert "<available-mcp-tools>" not in section
    assert "<tool_catalog>" in section
