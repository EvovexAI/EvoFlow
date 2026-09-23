"""Tests for multi-root SkillIndex discovery."""

from __future__ import annotations

import os
import tempfile

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
        _write_skill(tmp, os.path.join(".evoflow", "skills", "repo-skill"), "repo-skill")
        index = SkillIndex.load(
            skills_path=__import__("pathlib").Path(tmp) / "missing-primary",
            workspace_root=tmp,
        )
        assert index.get("repo-skill") is not None


def test_extra_roots_survive_explicit_skills_path():
    """Regression: extra_roots must apply even when skills_path is passed explicitly.

    ``load_skills()`` resolves the primary root first and then calls
    ``SkillIndex.load(skills_path=...)``; the old code only read configured extra
    roots in the ``skills_path is None`` branch, so configured extra roots were
    silently dropped on the real load path.
    """
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmp:
        primary = os.path.join(tmp, "primary")
        external = os.path.join(tmp, "external")
        _write_skill(primary, os.path.join("public", "primary-skill"), "primary-skill")
        _write_skill(external, "external-skill", "external-skill")

        index = SkillIndex.load(
            skills_path=Path(primary),
            extra_roots=[Path(external)],
        )
        names = {s.name for s in index.skills}
        assert "primary-skill" in names
        assert "external-skill" in names
        assert index.get("external-skill").scope == SkillScope.EXTERNAL


def test_extra_roots_override_beats_primary():
    """Explicit ``extra_roots=[]`` disables configured roots for that call."""
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmp:
        primary = os.path.join(tmp, "primary")
        external = os.path.join(tmp, "external")
        _write_skill(primary, os.path.join("public", "primary-skill"), "primary-skill")
        _write_skill(external, "external-skill", "external-skill")

        index = SkillIndex.load(
            skills_path=Path(primary),
            extra_roots=[],
        )
        names = {s.name for s in index.skills}
        assert "primary-skill" in names
        assert "external-skill" not in names


def test_mtime_map_covers_extra_roots():
    """Extra-root edits must invalidate the TTL cache."""
    from pathlib import Path

    from evoflow.skills.loader import _build_mtime_map

    with tempfile.TemporaryDirectory() as tmp:
        primary = os.path.join(tmp, "primary")
        external = os.path.join(tmp, "external")
        _write_skill(primary, os.path.join("public", "primary-skill"), "primary-skill")
        _write_skill(external, "external-skill", "external-skill")

        base = _build_mtime_map(Path(primary))
        assert not any(k.startswith("@extra:") for k in base)

        with_extra = _build_mtime_map(Path(primary), [Path(external)])
        assert any(k.startswith("@extra:") for k in with_extra)
        assert len(with_extra) == len(base) + 1
