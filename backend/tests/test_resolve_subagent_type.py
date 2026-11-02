"""Unknown / plugin-lookalike subagent_type must coerce to built-in agent."""

from __future__ import annotations

from evoflow.subagents.registry import resolve_subagent_type


def test_resolve_unknown_plugin_name_falls_back_to_agent():
    assert resolve_subagent_type("computer-use") == "agent"
    assert resolve_subagent_type("browser-use") == "agent"
    assert resolve_subagent_type("not-a-real-worker") == "agent"


def test_resolve_empty_defaults_to_agent():
    assert resolve_subagent_type("") == "agent"
    assert resolve_subagent_type(None) == "agent"
    assert resolve_subagent_type("   ") == "agent"


def test_resolve_legacy_general_purpose_alias():
    assert resolve_subagent_type("general-purpose") == "agent"
    assert resolve_subagent_type("general_purpose") == "agent"


def test_resolve_known_builtin_kept():
    assert resolve_subagent_type("agent") == "agent"
    assert resolve_subagent_type("code-agent") == "code-agent"
