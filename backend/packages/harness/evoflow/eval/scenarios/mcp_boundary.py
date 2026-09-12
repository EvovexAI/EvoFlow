"""Scenario: MCP server allowlist filters tools correctly."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import check_db_count


def _tool(name: str):
    return SimpleNamespace(name=name)


def _run(home: Path) -> dict:
    del home
    from evoflow.agents.lead_agent.agent import _filter_tools_by_mcp_servers

    tools = [_tool("read"), _tool("mcp__Playwright__a"), _tool("mcp__lark-mcp__b")]
    tool_names = [t.name for t in tools]
    keep_all = _filter_tools_by_mcp_servers(tools, None)
    bound = _filter_tools_by_mcp_servers(tools, ["Playwright"])
    empty = _filter_tools_by_mcp_servers(tools, [])

    assertions = [
        check(
            "none_keeps_all",
            [t.name for t in keep_all] == tool_names,
            inputs={"tools": tool_names, "mcp_servers": None},
            expected=tool_names,
            actual=[t.name for t in keep_all],
            api="_filter_tools_by_mcp_servers",
        ),
        check(
            "allowlist_playwright",
            [t.name for t in bound] == ["read", "mcp__Playwright__a"],
            inputs={"tools": tool_names, "mcp_servers": ["Playwright"]},
            expected=["read", "mcp__Playwright__a"],
            actual=[t.name for t in bound],
            api="_filter_tools_by_mcp_servers",
        ),
        check(
            "empty_drops_mcp",
            [t.name for t in empty] == ["read"],
            inputs={"tools": tool_names, "mcp_servers": []},
            expected=["read"],
            actual=[t.name for t in empty],
            api="_filter_tools_by_mcp_servers",
        ),
    ]
    persist = [
        check_db_count("db_mcp_servers_unchanged", "evoflow_mcp_servers", 0),
        check_db_count("db_agents_unchanged", "evoflow_agents", 0),
    ]
    return finalize(
        assertions + persist,
        steps=[
            {"step": 1, "api": "_filter_tools_by_mcp_servers(None)"},
            {"step": 2, "api": "_filter_tools_by_mcp_servers(['Playwright'])"},
            {"step": 3, "api": "_filter_tools_by_mcp_servers([])"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
