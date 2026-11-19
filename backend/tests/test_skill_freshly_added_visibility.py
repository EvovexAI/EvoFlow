"""回归：刚放进 custom/ 的技能必须立刻可见、可启用、可幂等安装。

缺陷背景（2026-11-19 实测）：把一个新技能目录写进生效根 custom/ 之后，
`skills.get` / `skills.enable` 报 "Skill ... not found"，而 `skills.install`
用磁盘判重报 "already exists"。两个接口依据不同数据源（注册表 vs 磁盘），
且 load_skills 在 TTL 内直接返回缓存不校验磁盘，导致新建技能最长 5 分钟
不可用，Agent 只能去改数据库——一次简单建技能被拖成十几分钟。
"""

from __future__ import annotations

from pathlib import Path

import pytest


def _write_skill(parent: Path, name: str) -> Path:
    skill_dir = parent / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: freshest demo skill\n---\n# {name}\n",
        encoding="utf-8",
    )
    return skill_dir


@pytest.fixture()
def skills_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "skills"
    (root / "public").mkdir(parents=True)
    (root / "custom").mkdir(parents=True)
    monkeypatch.setenv("EVOFLOW_SKILLS_PATH", str(root))
    from evoflow.skills import loader

    loader.clear_skills_cache()
    yield root
    loader.clear_skills_cache()


def test_skill_added_after_cache_is_visible_immediately(skills_root: Path) -> None:
    """缓存建立之后再落盘的新技能，下一次 load_skills 必须能看见。"""
    from evoflow.skills.loader import load_skills

    assert load_skills(enabled_only=False) is not None  # 先建立缓存

    _write_skill(skills_root / "custom", "freshly-added")

    names = [s.name for s in load_skills(enabled_only=False)]
    assert "freshly-added" in names, "新技能被缓存挡住，skills.get 会误报 not found"


def test_install_same_directory_is_idempotent(skills_root: Path) -> None:
    """目录已在 custom/ 下且就是源目录时，install 应幂等成功而非报 'already exists'。"""
    from evoflow.skills.installer import install_skill_from_directory

    skill_dir = _write_skill(skills_root / "custom", "idem-demo")

    result = install_skill_from_directory(skill_dir, skills_root=skills_root)

    assert result["success"] is True
    assert result.get("already_installed") is True
    assert skill_dir.is_dir(), "幂等安装不应删除/搬走已有目录"


def test_install_rejects_different_directory_with_same_name(skills_root: Path) -> None:
    """同名但来源不同的目录仍要拦下，避免静默覆盖用户已有技能。"""
    from evoflow.skills.installer import SkillAlreadyExistsError, install_skill_from_directory

    _write_skill(skills_root / "custom", "dup-demo")
    elsewhere = _write_skill(skills_root.parent / "elsewhere", "dup-demo")

    with pytest.raises(SkillAlreadyExistsError):
        install_skill_from_directory(elsewhere, skills_root=skills_root)
