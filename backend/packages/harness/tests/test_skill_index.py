"""Tests for multi-root SkillIndex discovery."""

from __future__ import annotations

import os
import tempfile

import pytest

from evoflow.skills.index import SkillIndex, SkillRootSpec, discover_skills_from_roots
from evoflow.skills.skill_scope import SkillScope


def _write_skill(base: str, rel: str, name: str) -> None:
    d = os.path.join(base, rel)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as fh:
        fh.write(f"---\nname: {name}\ndescription: Demo {name}\n---\n# {name}\n")


def test_external_root_overrides_public_name():
    with tempfile.TemporaryDirectory() as tmp:
        primary = os.path.join(tmp, "primary")
        external = os.path.join(tmp, "external")
        _write_skill(primary, os.path.join("public", "demo-skill"), "demo-skill")
        _write_skill(external, "demo-skill", "demo-skill")

        roots = [
            SkillRootSpec(path=__import__("pathlib").Path(external), scope=SkillScope.EXTERNAL),
            SkillRootSpec(path=__import__("pathlib").Path(primary), scope=SkillScope.PUBLIC),
        ]
        skills = discover_skills_from_roots(roots)
        by_name = {s.name: s for s in skills}
        assert "demo-skill" in by_name
        assert by_name["demo-skill"].scope == SkillScope.EXTERNAL


def test_repo_flat_layout():
    with tempfile.TemporaryDirectory() as tmp:
        repo_skills = os.path.join(tmp, ".evoflow", "skills", "repo-skill")
        _write_skill(tmp, os.path.join(".evoflow", "skills", "repo-skill"), "repo-skill")
        index = SkillIndex.load(
            skills_path=__import__("pathlib").Path(tmp) / "missing-primary",
            workspace_root=tmp,
        )
        assert index.get("repo-skill") is not None
