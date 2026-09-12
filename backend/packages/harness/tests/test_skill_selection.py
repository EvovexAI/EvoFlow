"""Tests for turn skill selection."""

from __future__ import annotations

import os
import tempfile

import pytest

from evoflow.skills.loader import clear_skills_cache
from evoflow.skills.selection import extract_skill_mentions, select_skills_for_turn


def _write_skill(base: str, name: str) -> None:
    d = os.path.join(base, "public", name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as fh:
        fh.write(f"---\nname: {name}\ndescription: Skill {name}\n---\n")


@pytest.fixture
def skills_root(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "skills")
        _write_skill(root, "alpha-skill")
        _write_skill(root, "beta-skill")
        import evoflow.skills.loader as loader_mod

        monkeypatch.setattr(loader_mod, "get_skills_root_path", lambda: __import__("pathlib").Path(root))
        clear_skills_cache()
        yield root


def test_extract_skill_mentions():
    assert extract_skill_mentions("Use $alpha-skill then $beta-skill") == ["alpha-skill", "beta-skill"]


def test_select_preferred_skills(skills_root, monkeypatch):
    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.list_skill_registry",
        lambda: {"alpha-skill": {"enabled": True}, "beta-skill": {"enabled": True}},
    )
    clear_skills_cache()
    selected = select_skills_for_turn(preferred_skills=["beta-skill"], enabled_only=False)
    assert [s.name for s in selected] == ["beta-skill"]


def test_select_ignores_agent_allowlist(skills_root, monkeypatch):
    """native-style: explicit user selection injects even when not in agent catalog allowlist."""
    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.list_skill_registry",
        lambda: {"alpha-skill": {"enabled": True}, "beta-skill": {"enabled": True}},
    )
    clear_skills_cache()
    selected = select_skills_for_turn(
        preferred_skills=["beta-skill"],
        enabled_only=False,
    )
    assert [s.name for s in selected] == ["beta-skill"]
