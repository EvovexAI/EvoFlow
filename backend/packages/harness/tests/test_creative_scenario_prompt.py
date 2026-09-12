"""Media crew subagents remain available without a dedicated creative scenario."""

from __future__ import annotations

from evoflow.agents.lead_agent.prompt import (
    _build_subagent_section,
    _enabled_modules_for_scenario,
)


def test_no_creative_scenario_profile() -> None:
    modules = _enabled_modules_for_scenario("creative")
    assert modules == ["chat"]
    assert "media_production" not in modules


def test_subagent_section_lists_media_crew_without_creative_scenario() -> None:
    section = _build_subagent_section(3, "TestAgent", prompt_language="zh", intent_hint="chat")
    assert "media-screenwriter" in section
    assert "media-artist" in section
    assert "byted-ark-seedream" in section or "media-production" in section or "media-*" in section
