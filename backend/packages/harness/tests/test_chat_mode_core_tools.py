"""日常对话（无活跃模式）仅绑定核心工具（tool_search；模式切换改由 UI）。"""

from __future__ import annotations

import pytest

from evoflow.agents.lead_agent.agent import _filter_tools_by_intent
from evoflow.agents.lead_agent.intent_tool_profile import (
    CORE_TOOL_NAMES,
    is_pure_chat_scenarios,
    resolve_prompt_scenario_csv,
    resolve_tools_for_scenarios,
)
from evoflow.tools.tools import _ADMIN_CLI_REPLACED_TOOL_NAMES


def test_resolve_tools_empty_is_core_plus_deferred_system() -> None:
    from evoflow.agents.lead_agent.intent_tool_profile import DEFERRED_SYSTEM_TOOL_NAMES

    names = set(resolve_tools_for_scenarios([]))
    assert names == set(CORE_TOOL_NAMES) | set(DEFERRED_SYSTEM_TOOL_NAMES)


def test_core_tools_are_tool_search_only() -> None:
    assert set(CORE_TOOL_NAMES) == {"tool_search"}


def test_is_pure_chat_scenarios() -> None:
    assert is_pure_chat_scenarios([])
    assert is_pure_chat_scenarios(["ask"])
    assert is_pure_chat_scenarios(["chat"])
    assert not is_pure_chat_scenarios(["agent"])


def test_resolve_prompt_scenario_csv_bound_workspace_no_longer_auto_agent() -> None:
    """Binding a workspace dir does NOT auto-activate agent mode."""
    assert resolve_prompt_scenario_csv(intent_hint=None, local_workspace_root="/tmp/proj") == "ask"
    assert resolve_prompt_scenario_csv(intent_hint="ask", local_workspace_root="D:\\repo") == "ask"


def test_resolve_prompt_scenario_csv_plan_wins_over_workspace_root() -> None:
    assert resolve_prompt_scenario_csv(intent_hint="plan", local_workspace_root="/tmp/proj") == "plan"


def test_resolve_prompt_scenario_csv_explicit_agent() -> None:
    assert resolve_prompt_scenario_csv(intent_hint="agent", local_workspace_root=None) == "agent"
    assert resolve_prompt_scenario_csv(intent_hint="workspace", local_workspace_root=None) == "agent"


def test_ask_mode_grants_core_plus_deferred_system() -> None:
    from evoflow.agents.lead_agent.intent_tool_profile import DEFERRED_SYSTEM_TOOL_NAMES

    tools = set(resolve_tools_for_scenarios(["ask"]))
    assert tools == set(CORE_TOOL_NAMES) | set(DEFERRED_SYSTEM_TOOL_NAMES)
    assert "ask_clarification" in tools
    assert "subagent" not in tools
    assert "read" not in tools
    assert "terminal" not in tools
    assert "list_agents" not in tools


def test_agent_mode_includes_baseline_tools() -> None:
    tools = set(resolve_tools_for_scenarios(["agent"]))
    assert "read" in tools
    assert "rg" in tools
    assert "terminal" in tools
    # "worker" temporarily unregistered — keep subagent/process/mind_map as baseline signals
    assert "subagent" in tools
    assert "mind_map" in tools
    assert "process" in tools
    assert tools.isdisjoint(_ADMIN_CLI_REPLACED_TOOL_NAMES)


def test_agent_mind_map_in_baseline_not_core(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.tools.builtins.mind_map_tool import mind_map_tool
    from evoflow.tools.builtins.process_tool import process_tool
    from evoflow.tools.builtins.tool_search import tool_search

    sample = [tool_search, mind_map_tool, process_tool]
    ask_tools = {t.name for t in _filter_tools_by_intent(sample, "ask")}
    assert ask_tools == {"tool_search"}
    monkeypatch.setenv("EVOFLOW_SCENARIO_EAGER_TOOLS", "1")
    agent_tools = {t.name for t in _filter_tools_by_intent(sample, "agent")}
    assert "mind_map" in agent_tools
    assert "process" not in agent_tools
    monkeypatch.setenv("EVOFLOW_SCENARIO_EAGER_TOOLS", "0")
    legacy_agent = {t.name for t in _filter_tools_by_intent(sample, "agent")}
    assert "process" in legacy_agent


def test_plan_scenario_includes_orchestration_read_and_peer_tools() -> None:
    tools = set(resolve_tools_for_scenarios(["plan"]))
    assert "plan" in tools
    assert "supervisor" in tools
    assert "subagent" in tools
    assert "read" in tools
    assert "list_agents" in tools
    assert "collab_peer_read" in tools
    assert "search_code_index" in tools
