"""ScenarioNotActivated heal: auto-activate agent when tool needs it."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from evoflow.agents.middlewares.plan_guard_middleware import (
    _gate_tool_without_required_scenario,
    _try_auto_activate_agent_for_tool,
)
from evoflow.tools.builtins.scenario_activation import (
    get_activated_scenarios,
    reset_activated_scenario,
)


def _request(tool_name: str):
    return SimpleNamespace(
        tool_call={"name": tool_name, "id": "call-1", "args": {}},
        runtime=SimpleNamespace(context={}, state={"messages": []}),
        state={"messages": []},
    )


def test_try_auto_activate_agent_for_bash() -> None:
    reset_activated_scenario()
    try:
        req = _request("bash")
        assert "agent" not in (get_activated_scenarios() or [])
        ok = _try_auto_activate_agent_for_tool(req, "bash")
        assert ok is True
        assert "agent" in get_activated_scenarios()
    finally:
        reset_activated_scenario()


def test_gate_allows_bash_after_auto_activate() -> None:
    reset_activated_scenario()
    try:
        blocked = _gate_tool_without_required_scenario(_request("bash"))
        assert blocked is None
        assert "agent" in get_activated_scenarios()
    finally:
        reset_activated_scenario()


def test_agent_grants_grep_not_plan_only() -> None:
    """Regression: grep/glob were plan-only → ScenarioNotActivated(plan) while
    prompt says「勿 activate plan」→ model falls back to Bash rg/sed for half hour.
    """
    from evoflow.agents.lead_agent.intent_tool_profile import (
        recommended_scenario_for_tool,
        resolve_tools_for_scenarios,
        scenarios_granting_tool,
    )

    agent_tools = set(resolve_tools_for_scenarios(["agent"]))
    assert "grep" in agent_tools
    assert "glob" not in agent_tools
    assert "search_code_index" in agent_tools
    # Plan mode offline: grant / recommend surfaces must never mention plan.
    assert scenarios_granting_tool("grep") == ["agent"]
    assert scenarios_granting_tool("glob") == []
    assert "plan" not in scenarios_granting_tool("grep")
    assert recommended_scenario_for_tool("grep", ["plan"]) == "agent"
    assert recommended_scenario_for_tool("anything", None) == "agent"


def test_gate_allows_grep_after_auto_activate() -> None:
    reset_activated_scenario()
    try:
        blocked = _gate_tool_without_required_scenario(_request("grep"))
        assert blocked is None, getattr(blocked, "content", blocked)
        assert "agent" in get_activated_scenarios()
    finally:
        reset_activated_scenario()
