"""Tier-1 eager tool binding vs full scenario union (P1 progressive loading)."""

from __future__ import annotations

import json

import pytest

from evoflow.agents.lead_agent.agent import _filter_tools_by_intent
from evoflow.agents.lead_agent.intent_tool_profile import (
    CORE_TOOL_NAMES,
    build_scenario_tools_payload,
    resolve_deferred_tool_names_for_scenarios,
    resolve_eager_tool_names_for_scenarios,
    resolve_tools_for_scenarios,
)
from evoflow.tools.builtins.mind_map_tool import mind_map_tool
from evoflow.tools.builtins.process_tool import process_tool
from evoflow.tools.builtins.scenario_activation import mode_set, reset_activated_scenario, scenario
from evoflow.tools.builtins.worker_tool import worker_tool


def test_resolve_eager_agent_is_smaller_than_full_union() -> None:
    full = set(resolve_tools_for_scenarios(["agent"]))
    eager = resolve_eager_tool_names_for_scenarios(["agent"])
    assert set(CORE_TOOL_NAMES).issubset(eager)
    assert "read" in eager
    assert "terminal" in eager
    assert "worker" not in eager
    assert "process" not in eager
    assert "browser" not in eager
    assert "web_search" not in eager
    assert eager.issubset(full)
    assert len(eager) < len(full)


def test_resolve_deferred_agent_includes_heavy_tools() -> None:
    deferred = set(resolve_deferred_tool_names_for_scenarios(["agent"]))
    # "worker" temporarily unregistered — keep process/browser as heavy-tool signals
    assert "process" in deferred
    assert "browser" in deferred
    assert "fetch_url" in deferred
    assert "find" in deferred
    assert "invoke_acp_agent" in deferred
    assert "session_workspace" in deferred
    assert "panel_set" not in deferred
    assert "platform" not in deferred
    eager = resolve_eager_tool_names_for_scenarios(["agent"])
    assert "panel_set" in eager
    assert "platform" in eager


def test_resolve_eager_plan_keeps_orchestration_and_read_tools() -> None:
    eager = resolve_eager_tool_names_for_scenarios(["plan"])
    assert "plan" in eager
    assert "supervisor" in eager
    assert "subagent" in eager
    assert "read" in eager
    assert "list_agents" in eager
    assert "collab_peer_send" in eager
    assert "propose_goal" not in eager


def test_filter_tools_by_intent_eager_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_SCENARIO_EAGER_TOOLS", "1")
    sample = [scenario, mind_map_tool, process_tool, worker_tool]
    names = {t.name for t in _filter_tools_by_intent(sample, "agent")}
    # mode_set 暂不在 CORE_TOOL_NAMES；样本里的 scenario/mode_set 不会被 agent eager 选中
    assert names == {"mind_map"}
    assert "mode_set" not in names
    assert "process" not in names
    assert "worker" not in names


def test_filter_tools_by_intent_eager_agent_no_read_substring_leaks(monkeypatch: pytest.MonkeyPatch) -> None:
    """``read`` eager must not bind ``read_lints`` / ``collab_peer_read`` via substring match."""
    from types import SimpleNamespace

    from evoflow.tools.builtins.read_lints_tool import read_lints_tool
    from evoflow.tools.builtins.collab_peer_tools import collab_peer_read_tool

    monkeypatch.setenv("EVOFLOW_SCENARIO_EAGER_TOOLS", "1")
    sample = [
        scenario,
        mind_map_tool,
        read_lints_tool,
        collab_peer_read_tool,
        SimpleNamespace(name="read_file"),
    ]
    names = {t.name for t in _filter_tools_by_intent(sample, "agent")}
    assert "read_lints" not in names
    assert "collab_peer_read" not in names
    assert "read_file" in names
    assert "read" in resolve_eager_tool_names_for_scenarios(["agent"])


def test_filter_tools_by_intent_legacy_full_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_SCENARIO_EAGER_TOOLS", "0")
    sample = [scenario, mind_map_tool, process_tool]
    names = {t.name for t in _filter_tools_by_intent(sample, "agent")}
    assert "mind_map" in names
    assert "process" in names


def test_build_scenario_tools_payload_agent() -> None:
    payload = build_scenario_tools_payload(["agent"])
    # "worker" temporarily unregistered
    assert "process" in payload["deferred_tools"]
    assert "process" not in payload["activated_tools"]
    assert "read" in payload["activated_tools"]
    assert "panel_set" in payload["activated_tools"]
    assert "platform" in payload["activated_tools"]
    assert "process" in payload["all_granted_tools"]


def test_scenario_activate_includes_deferred_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_SCENARIO_EAGER_TOOLS", "1")
    reset_activated_scenario()
    raw = mode_set.invoke({"action": "activate", "mode": "agent", "reason": "test"})
    payload = json.loads(raw)
    assert payload["status"] == "success"
    assert "read" in payload["activated_tools"]
    assert "panel_set" in payload["activated_tools"]
    assert "platform" in payload["activated_tools"]
    assert "process" in payload["deferred_tools"]
    assert "process" in payload["all_granted_tools"]
    assert "deferred_tools" in payload["tool_activation_note"]
    reset_activated_scenario()
