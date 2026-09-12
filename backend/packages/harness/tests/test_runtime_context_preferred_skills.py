"""Session-sticky preferred_skills resolution for skill injection."""

from __future__ import annotations

from evoflow.agents.lead_agent.runtime_context import resolve_preferred_skills_for_turn


def test_resolve_preferred_skills_from_run_context() -> None:
    assert resolve_preferred_skills_for_turn({"preferred_skills": ["canvas-design"]}) == ["canvas-design"]


def test_resolve_preferred_skills_session_fallback(monkeypatch) -> None:
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.get_session_context_for_run_config",
        lambda sk: {"preferred_skills": ["canvas-design"]} if sk == "agent:main:abc" else {},
    )
    assert resolve_preferred_skills_for_turn({"session_key": "agent:main:abc"}) == ["canvas-design"]


def test_run_context_wins_over_session_fallback(monkeypatch) -> None:
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.get_session_context_for_run_config",
        lambda sk: {"preferred_skills": ["canvas-design"]},
    )
    assert resolve_preferred_skills_for_turn(
        {"session_key": "agent:main:abc", "preferred_skills": ["evoflow-admin"]}
    ) == ["evoflow-admin"]
