"""plan 场景解析出的可用工具须包含 subagent（核心工具 + plan 场景并集）。"""

from __future__ import annotations

from evoflow.agents.lead_agent.intent_tool_profile import ACTIVATABLE_SCENARIO_KEYS, resolve_tools_for_scenarios
from evoflow.tools.builtins.scenario_activation import get_scenario_key_enum_description, scenario


def test_plan_scenario_resolves_subagent_tool() -> None:
    tools = resolve_tools_for_scenarios(["plan"])
    assert "subagent" in tools
    assert "supervisor" in tools
    assert "plan" in tools
    assert "propose_goal" in tools
    assert "read" in tools
    assert "collab_peer_send" in tools


def test_workspace_scenario_includes_web_research_tools() -> None:
    tools = set(resolve_tools_for_scenarios(["agent"]))
    assert "web_search" in tools
    assert "fetch_url" in tools
    assert "web_fetch" not in tools
    assert "write" in tools
    assert "mind_map" in tools
    assert "process" in tools


def test_workspace_scenario_extras_exclude_core_tools() -> None:
    from evoflow.agents.lead_agent.intent_tool_profile import CORE_TOOL_NAMES

    core = set(CORE_TOOL_NAMES)
    ws = set(resolve_tools_for_scenarios(["agent"]))
    extras = ws - core
    assert not extras & core
    assert "read" in extras
    assert "terminal" in extras
    assert "worker" in extras
    assert "rg" in extras
    assert "mind_map" in extras
    assert "mind_map" in ws


def test_chat_only_scenario_does_not_include_propose_goal() -> None:
    tools = resolve_tools_for_scenarios(["ask"])
    assert "propose_goal" not in tools
    assert "web_search" not in tools


def test_scenario_key_enum_description_lists_core_scenarios_only() -> None:
    doc = get_scenario_key_enum_description()
    assert "**plan**" in doc
    assert "**agent**" in doc
    assert "**web**" not in doc
    assert "**manage**" not in doc
    assert "**evolve**" not in doc
    assert "`web_search`" in doc


def test_scenario_tool_schema_exposes_action_and_scenario_key_enums() -> None:
    schema = scenario.args_schema.model_json_schema()
    props = schema["properties"]
    assert props["action"]["enum"] == ["activate", "deactivate"]
    assert set(props["scenario_key"]["enum"]) == set(ACTIVATABLE_SCENARIO_KEYS) | {"ask"}
    assert "**manage**" not in props["scenario_key"]["description"]
    assert "**evolve**" not in props["scenario_key"]["description"]
    desc = props["scenario_key"]["description"]
    assert "无需 activate，仅含" not in desc
    assert "`propose_goal`" in desc
