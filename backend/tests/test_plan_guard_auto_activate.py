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
