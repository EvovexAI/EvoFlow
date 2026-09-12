"""tool_search loads workspace builtins (mind_map) from catalog, not only MCP deferred tools."""

from __future__ import annotations

import json

import pytest
from langchain.tools import tool as lc_tool
from pydantic import ValidationError

from evoflow.tools.builtins.mind_map_tool import mind_map_tool
from evoflow.tools.builtins.tool_search import (
    DeferredToolRegistry,
    ToolSearchInput,
    reset_deferred_registry,
    set_deferred_registry,
    set_tool_search_catalog,
    tool_search,
)


def test_tool_search_select_mind_map_loads_from_catalog() -> None:
    reset_deferred_registry()
    set_tool_search_catalog([mind_map_tool], bound_names={"scenario", "tool_search"})
    out = tool_search.invoke({"query": "select:mind_map"})
    parsed = json.loads(out)
    assert parsed["status"] == "ok"
    assert "mind_map" in parsed["activated_now"]
    assert parsed["tool_defs"]
    reset_deferred_registry()


def test_tool_search_select_mind_map_already_bound() -> None:
    reset_deferred_registry()
    set_tool_search_catalog([mind_map_tool], bound_names={"mind_map", "scenario"})
    out = tool_search.invoke({"query": "select:mind_map"})
    parsed = json.loads(out)
    assert parsed["status"] == "already_activated"
    assert "mind_map" in parsed["tools"]
    reset_deferred_registry()


def test_tool_search_select_deferred_still_works() -> None:
    @lc_tool
    def sample_mcp_tool(x: str) -> str:
        """Sample deferred tool for tests."""
        return x

    reset_deferred_registry()
    registry = DeferredToolRegistry()
    registry.register(sample_mcp_tool)
    set_deferred_registry(registry)
    set_tool_search_catalog([sample_mcp_tool], bound_names=set())
    out = tool_search.invoke({"query": "select:sample_mcp_tool"})
    parsed = json.loads(out)
    assert parsed["status"] == "ok"
    assert "sample_mcp_tool" in parsed["activated_now"]
    reset_deferred_registry()


def test_tool_search_accepts_select_kwarg_alias() -> None:
    """Models often pass {"select":"subagent"} after reading `select:subagent` hints."""
    reset_deferred_registry()
    set_tool_search_catalog([mind_map_tool], bound_names={"scenario", "tool_search"})
    out = tool_search.invoke({"select": "mind_map"})
    parsed = json.loads(out)
    assert parsed["status"] == "ok"
    assert "mind_map" in parsed["activated_now"]
    reset_deferred_registry()


def test_tool_search_input_normalizes_select_alias() -> None:
    assert ToolSearchInput(select="subagent").query == "select:subagent"
    assert ToolSearchInput(select="select:write,replace").query == "select:write,replace"
    assert ToolSearchInput(query="select:subagent").query == "select:subagent"
    with pytest.raises(ValidationError):
        ToolSearchInput()
