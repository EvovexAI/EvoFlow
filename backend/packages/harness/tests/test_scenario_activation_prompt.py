"""Scenario activation line in system prompt matches runtime/session mode."""

from __future__ import annotations

from evoflow.agents.lead_agent.intent_tool_profile import (
    resolve_active_scenario_keys_for_display,
    scenario_keys_from_session_mode,
)
from evoflow.agents.lead_agent.prompt import apply_prompt_template
from evoflow.agents.middlewares.plan_guard_middleware import effective_activated_scenario_keys


def test_scenario_keys_from_session_mode_agent() -> None:
    assert scenario_keys_from_session_mode("agent") == ["agent"]
    assert scenario_keys_from_session_mode("ask") == []
    assert scenario_keys_from_session_mode("plan") == ["plan"]


def test_resolve_active_scenario_keys_prefers_intent_over_session_mode() -> None:
    keys = resolve_active_scenario_keys_for_display(intent_hint="plan", session_mode="agent")
    assert keys == ["plan"]


def test_resolve_active_scenario_keys_uses_session_mode_when_no_intent() -> None:
    keys = resolve_active_scenario_keys_for_display(intent_hint=None, session_mode="agent")
    assert keys == ["agent"]


def test_apply_prompt_template_omits_session_mode_policy() -> None:
    text = apply_prompt_template(
        intent_hint=None,
        available_skills=set(),
        session_mode="agent",
        prompt_language="en",
    )
    assert "<session_mode_policy>" not in text
    assert "Active mode:" not in text
    assert "<scenario_activation>" not in text
    assert "<tool_catalog>" in text

def test_format_active_modes_for_display() -> None:
    from evoflow.agents.lead_agent.intent_tool_profile import format_active_modes_for_display

    assert format_active_modes_for_display(["agent"]) == "Agent"
    assert format_active_modes_for_display([]) == "Ask (baseline)"
    assert format_active_modes_for_display(["plan", "agent"]) == "Plan, Agent"


def test_effective_activated_scenario_keys_falls_back_to_session_mode() -> None:
    runtime = type("R", (), {"context": {"session_mode": "agent"}})()
    keys = effective_activated_scenario_keys(runtime, [])
    assert "agent" in keys
