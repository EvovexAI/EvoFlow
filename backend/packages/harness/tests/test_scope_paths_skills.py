"""Scope filesystem layout + layered skill discovery."""

from __future__ import annotations

import gc
import tempfile
from pathlib import Path

import pytest

from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.schema import ensure_app_schema

_EVOFLOW_ROOT = Path(__file__).resolve().parents[4]


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp) / "evoflow-home"
        home.mkdir()
        monkeypatch.setenv("EVOFLOW_HOME", str(home))
        monkeypatch.setenv("EVOFLOW_CONFIG_PATH", str(_EVOFLOW_ROOT / "config.yaml"))
        monkeypatch.setenv("EVOFLOW_ACL_MODE", "shadow")
        reset_db_for_tests()
        yield home
        reset_db_for_tests()
        gc.collect()


def test_ensure_principal_home_creates_layout(sqlite_tmp: Path) -> None:
    from evoflow.authz.principals import create_principal
    from evoflow.authz.scope_paths import (
        personal_scope_id,
        scope_agents_dir,
        scope_files_dir,
        scope_skills_dir,
    )

    ensure_app_schema(get_db())
    p = create_principal(display_name="Alice", principal_id="user:alice")
    sid = personal_scope_id("user:alice")
    assert (scope_skills_dir(sid) / "custom").is_dir()
    assert (scope_skills_dir(sid) / "public").is_dir()
    assert scope_agents_dir(sid).is_dir()
    assert scope_files_dir(sid).is_dir()
    assert (sqlite_tmp / "scopes" / "personal" / "user__alice").is_dir() or (
        sqlite_tmp / "scopes" / "personal"
    ).is_dir()
    assert p["principal_id"] == "user:alice"


def test_skill_index_includes_personal_root(sqlite_tmp: Path) -> None:
    from evoflow.authz.principals import create_principal
    from evoflow.authz.scope_paths import personal_scope_id, scope_skills_dir
    from evoflow.authz.skill_roots import scope_skill_roots_for_principal
    from evoflow.skills.index import SkillIndex, build_skill_roots
    from evoflow.skills.skill_scope import SkillScope

    ensure_app_schema(get_db())
    alice = create_principal(display_name="Alice", principal_id="user:alice")
    personal = scope_skills_dir(personal_scope_id("user:alice"))
    skill_dir = personal / "custom" / "alice-only"
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: alice-only\ndescription: personal skill\n---\n# Alice\n",
        encoding="utf-8",
    )

    primary = sqlite_tmp / "skills"
    (primary / "public").mkdir(parents=True, exist_ok=True)

    scope_roots = scope_skill_roots_for_principal(alice)
    roots = build_skill_roots(
        primary_root=primary,
        scope_skill_roots=scope_roots,
    )
    assert any(r.scope == SkillScope.PERSONAL for r in roots)
    assert any(r.scope == SkillScope.ORG for r in roots)

    index = SkillIndex.load(skills_path=primary, scope_skill_roots=scope_roots)
    names = {s.name for s in index.skills}
    assert "alice-only" in names
    skill = index.get("alice-only")
    assert skill is not None
    assert skill.scope == SkillScope.PERSONAL


def test_personal_skill_overrides_public_same_name(sqlite_tmp: Path) -> None:
    from evoflow.authz.principals import create_principal
    from evoflow.authz.scope_paths import personal_scope_id, scope_skills_dir
    from evoflow.authz.skill_roots import scope_skill_roots_for_principal
    from evoflow.skills.index import SkillIndex
    from evoflow.skills.skill_scope import SkillScope

    ensure_app_schema(get_db())
    alice = create_principal(display_name="Alice", principal_id="user:alice")

    primary = sqlite_tmp / "skills"
    pub = primary / "public" / "shared-tool"
    pub.mkdir(parents=True, exist_ok=True)
    (pub / "SKILL.md").write_text(
        "---\nname: shared-tool\ndescription: public version\n---\n# Public\n",
        encoding="utf-8",
    )

    personal = scope_skills_dir(personal_scope_id("user:alice")) / "custom" / "shared-tool"
    personal.mkdir(parents=True, exist_ok=True)
    (personal / "SKILL.md").write_text(
        "---\nname: shared-tool\ndescription: personal version\n---\n# Personal\n",
        encoding="utf-8",
    )

    index = SkillIndex.load(
        skills_path=primary,
        scope_skill_roots=scope_skill_roots_for_principal(alice),
    )
    skill = index.get("shared-tool")
    assert skill is not None
    assert skill.scope == SkillScope.PERSONAL
    assert "personal version" in skill.description
