"""plan 模式独占：不可与 agent 等并存。"""

from __future__ import annotations

import json

import pytest

from evoflow.tools.builtins.scenario_activation import (
    _add_scenario,
    get_activated_scenarios,
    replace_activated_scenarios_from_mission_list,
    reset_activated_scenario,
    scenario,
)


@pytest.fixture(autouse=True)
def _clear_scenario_state() -> None:
    reset_activated_scenario()
    yield
    reset_activated_scenario()


def test_activate_plan_clears_other_scenarios() -> None:
    replace_activated_scenarios_from_mission_list(["agent"])
    cleared = _add_scenario("plan")
    assert cleared == ["agent"]
    assert get_activated_scenarios() == ["plan"]


def test_activate_non_plan_drops_active_plan() -> None:
    replace_activated_scenarios_from_mission_list(["plan"])
    cleared = _add_scenario("agent")
    assert cleared == ["plan"]
    assert get_activated_scenarios() == ["agent"]


def test_legacy_web_alias_normalizes_to_agent() -> None:
    _add_scenario("web")
    assert get_activated_scenarios() == ["agent"]


def test_scenario_tool_activate_ask_clears_scenarios() -> None:
    replace_activated_scenarios_from_mission_list(["agent"])
    raw = scenario.invoke({"action": "activate", "scenario_key": "ask", "reason": "back to ask"})
    payload = json.loads(raw)
    assert payload["status"] == "success"
    assert payload["all_active_scenarios"] == []
    assert get_activated_scenarios() == []
    assert "核心工具" in payload["message"]


def test_scenario_tool_activate_plan_reports_auto_cleared() -> None:
    replace_activated_scenarios_from_mission_list(["web"])
    raw = scenario.invoke({"action": "activate", "scenario_key": "plan", "reason": "test"})
    payload = json.loads(raw)
    assert payload["status"] == "success"
    assert payload["all_active_scenarios"] == ["plan"]
    assert payload.get("auto_cleared_scenarios") == ["agent"]
