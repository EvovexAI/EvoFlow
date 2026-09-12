"""Tests for native-style native MCP prompt and binding."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from evoflow.agents.lead_agent.agent import (
    _agent_mcp_skill_mode_enabled,
    _filter_tools_by_mcp_servers,
    _mcp_use_skill_binding,
)
from evoflow.mcp.binding import (
    filter_tools_by_mcp_servers,
    is_mcp_tool_name,
    mcp_server_from_tool_name,
    qualified_mcp_tool_name,
    role_has_mcp_binding,
)
from evoflow.mcp.native_prompt import build_mcp_native_prompt_section


def test_mcp_skill_mode_always_off() -> None:
    with patch.dict("os.environ", {"EVOFLOW_MCP_TOOL_BINDING": "skill"}):
        assert _mcp_use_skill_binding() is False
        cfg = SimpleNamespace(mcp_servers=["Playwright"])
        assert _agent_mcp_skill_mode_enabled(cfg) is False


def test_mcp_double_underscore_tool_naming() -> None:
    assert qualified_mcp_tool_name("Playwright", "click") == "mcp__Playwright__click"
    assert is_mcp_tool_name("mcp__Playwright__click") is True
    assert mcp_server_from_tool_name("mcp__Playwright__click") == "Playwright"
    assert mcp_server_from_tool_name("read") is None
    # Legacy names still parse for transition
    assert mcp_server_from_tool_name("Playwright__click") == "Playwright"


def test_role_has_mcp_binding() -> None:
    assert role_has_mcp_binding(SimpleNamespace(mcp_servers=None)) is True
    assert role_has_mcp_binding(SimpleNamespace(mcp_servers=["a"])) is True
    assert role_has_mcp_binding(SimpleNamespace(mcp_servers=[])) is False


def test_filter_tools_by_mcp_servers() -> None:
    tools = [
        SimpleNamespace(name="read"),
        SimpleNamespace(name="mcp__Playwright__click"),
        SimpleNamespace(name="mcp__Other__x"),
    ]
    out = filter_tools_by_mcp_servers(tools, ["Playwright"])
    assert [t.name for t in out] == ["read", "mcp__Playwright__click"]


def test_filter_tools_empty_list_strips_mcp() -> None:
    tools = [
        SimpleNamespace(name="read"),
        SimpleNamespace(name="mcp__Playwright__click"),
    ]
    out = _filter_tools_by_mcp_servers(tools, [])
    assert [t.name for t in out] == ["read"]


def test_build_mcp_native_prompt_section() -> None:
    fake_cfg = {"Playwright": {"enabled": True, "command": "npx"}}
    with patch("evoflow.mcp.tools.load_mcp_config", return_value=fake_cfg):
        text = build_mcp_native_prompt_section(
            ["Playwright"],
            bound_tool_names=["mcp__Playwright__click"],
            prompt_language="zh",
        )
    assert "<mcp_system>" in text
    assert "mcp__Playwright__click" in text
    assert "mcp-terminal" in text.lower() or "禁止" in text
