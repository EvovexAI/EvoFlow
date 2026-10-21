"""describe_skills_root_context — 多技能根目录诊断（问题：技能装了但不生效）。"""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.skills import loader


@pytest.fixture()
def fake_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", staticmethod(lambda: home))
    monkeypatch.delenv("EVOFLOW_SKILLS_PATH", raising=False)
    monkeypatch.delenv("EVOFLOW_HOME", raising=False)
    # 隔离开发机仓库 checkout（D:\...\EvoFlow\skills）这个真实候选根
    monkeypatch.setattr(loader, "_skills_root_from_source_tree", lambda: None)
    return home


def _make_custom_skill(root: Path, name: str) -> None:
    skill_dir = root / "custom" / name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: test\n---\n\nbody\n",
        encoding="utf-8",
    )


def test_default_root_and_profile_warning(fake_home: Path) -> None:
    default_root = fake_home / ".evoflow" / "skills"
    _make_custom_skill(default_root, "alpha")

    profile_root = fake_home / ".evoflow" / "profiles" / "default" / "skills"
    _make_custom_skill(profile_root, "beta")

    ctx = loader.describe_skills_root_context()

    assert ctx["active"] == str(default_root)
    assert ctx["active_source"].startswith("默认回退")
    paths = {c["path"]: c for c in ctx["candidates"]}
    assert paths[str(profile_root)]["custom_skills"] == 1
    assert paths[str(profile_root)]["orphan_only_custom"] == 1
    assert any(str(profile_root) in w for w in ctx["warnings"])
    assert any("skills.import_orphans" in w for w in ctx["warnings"])


def test_no_warning_when_orphan_already_mirrored(fake_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Inactive root still has the skill, but active already has a copy → no warning."""
    active_root = fake_home / ".evoflow" / "profiles" / "default" / "skills"
    orphan_root = fake_home / ".evoflow-dev" / "skills"
    _make_custom_skill(active_root, "shared")
    _make_custom_skill(orphan_root, "shared")
    monkeypatch.setenv("EVOFLOW_SKILLS_PATH", str(active_root))

    ctx = loader.describe_skills_root_context()

    assert ctx["active"] == str(active_root)
    paths = {c["path"]: c for c in ctx["candidates"]}
    assert paths[str(orphan_root)]["custom_skills"] == 1
    assert paths[str(orphan_root)]["orphan_only_custom"] == 0
    assert ctx["warnings"] == []


def test_env_skills_path_wins(fake_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    explicit_root = fake_home / "profiles" / "default" / "skills"
    _make_custom_skill(explicit_root, "gamma")
    monkeypatch.setenv("EVOFLOW_SKILLS_PATH", str(explicit_root))

    ctx = loader.describe_skills_root_context()

    assert ctx["active"] == str(explicit_root)
    assert ctx["active_source"] == "EVOFLOW_SKILLS_PATH"


def test_evoflow_home_isolation_no_false_warning(fake_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """EVOFLOW_HOME 指到独立 home（开发隔离）时，生效根跟着走，不该对不存在的候选根告警。"""
    home = fake_home
    active_root = home / ".evoflow-dev" / "profiles" / "p1" / "skills"
    _make_custom_skill(active_root, "delta")
    monkeypatch.setenv("EVOFLOW_HOME", str(active_root.parent))

    ctx = loader.describe_skills_root_context()

    assert ctx["active"] == str(active_root)
    # 其余候选根都不存在 → 不产生「非生效根有技能」告警
    assert ctx["warnings"] == []


def test_no_warning_when_single_root(fake_home: Path) -> None:
    default_root = fake_home / ".evoflow" / "skills"
    _make_custom_skill(default_root, "solo")

    ctx = loader.describe_skills_root_context()

    assert ctx["warnings"] == []
