"""Agent assignee resolution for plan / supervisor."""

from __future__ import annotations

from evoflow.collab.agent_assignment import (
    clear_assignable_agent_cache,
    resolve_assignable_agent,
    resolve_step_assigned_agent,
)


def test_resolve_assignable_agent_builtin() -> None:
    clear_assignable_agent_cache()
    code, name, warns = resolve_assignable_agent("general-purpose")
    assert code == "general-purpose"
    assert name == "通用助手"
    assert not warns


def test_resolve_assignable_agent_unknown_fallback() -> None:
    clear_assignable_agent_cache()
    code, name, warns = resolve_assignable_agent("not-a-real-agent-code")
    assert code == "general-purpose"
    assert name == "通用助手"
    assert any("unknown_agent" in w for w in warns)


def test_resolve_step_assigned_agent_from_display_name() -> None:
    clear_assignable_agent_cache()
    code, name, _ = resolve_step_assigned_agent({"assignee": "通用助手"})
    assert code == "general-purpose"
    assert name == "通用助手"
