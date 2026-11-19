"""回归：重复 install 同一来源目录必须幂等（copy / bound 两种模式）。

缺陷背景（2026-11-19）：技能目录已位于生效根 custom/<name> 时，
`skills.install(path=<同一目录>)` 一律抛 "already exists"；同时
`skills.get` 因注册表未同步报 "not found"。两个接口互相矛盾，Agent 只会
反复重试或去改数据库。修法：source 与目标同源时返回 success +
already_installed，只有「同名但来源不同」才继续报冲突。
"""

from __future__ import annotations

from pathlib import Path

import pytest


def _write_skill(parent: Path, name: str) -> Path:
    skill_dir = parent / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: idempotent install demo\n---\n# {name}\n",
        encoding="utf-8",
    )
    return skill_dir


@pytest.fixture()
def skills_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "skills"
    (root / "public").mkdir(parents=True)
    (root / "custom").mkdir(parents=True)
    monkeypatch.setenv("EVOFLOW_SKILLS_PATH", str(root))

    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.skills import loader

    # 隔离真实注册表：只保留本次用例写入的 bound 记录。
    registry: dict[str, dict] = {}
    monkeypatch.setattr(cfg_repo, "list_skill_registry", lambda: dict(registry))
    monkeypatch.setattr(cfg_repo, "get_skill_registry", lambda name: registry.get(name))

    def _upsert_skill_registry(name, **fields):
        registry[name] = {**fields, "name": name}

    monkeypatch.setattr(cfg_repo, "upsert_skill_registry", _upsert_skill_registry)
    monkeypatch.setattr(
        "evoflow.persistence.bootstrap.sync_skills_from_filesystem",
        lambda **_kwargs: None,
    )
    loader.clear_skills_cache()
    yield root
    loader.clear_skills_cache()


def test_copy_install_of_same_directory_is_idempotent(skills_root: Path) -> None:
    from evoflow.skills.installer import install_skill_from_directory

    skill_dir = _write_skill(skills_root / "custom", "idem-copy")

    first = install_skill_from_directory(skill_dir, skills_root=skills_root, mode="copy")
    second = install_skill_from_directory(skill_dir, skills_root=skills_root, mode="copy")

    assert first["success"] is True
    assert second["success"] is True
    assert second.get("already_installed") is True
    assert second["install_mode"] == "copy"
    assert (skill_dir / "SKILL.md").is_file(), "幂等安装不得删除已有目录"


def test_bound_on_dir_already_in_custom_reports_copy_not_bound(skills_root: Path) -> None:
    """源目录已在 custom/ 下时请求 bound：如实报 copy，不得谎报 bound。

    历史缺陷：这里原先只要「槽位==源目录」就返回 install_mode=bound +
    already_installed，但数据库里一条 bound 行都没写，是假成功。
    语义上也不该写：目录已在生效根，磁盘扫描本就会加载它，再挂一条 bound
    记录只会制造「删除后经扫盘复活」的坑。
    """
    from evoflow.skills.installer import install_skill_from_directory

    skill_dir = _write_skill(skills_root / "custom", "idem-bound")

    first = install_skill_from_directory(skill_dir, skills_root=skills_root, mode="bound")
    second = install_skill_from_directory(skill_dir, skills_root=skills_root, mode="bound")

    assert first["install_mode"] == "copy"
    assert first.get("already_installed") is True
    assert second["success"] is True
    assert second.get("already_installed") is True
    assert skill_dir.is_dir()


def test_bound_external_directory_is_idempotent(skills_root: Path) -> None:
    """真正的外部目录（生效根之外）in-place 注册，重复 install 仍应幂等 bound。"""
    from evoflow.skills.installer import install_skill_from_directory

    external = _write_skill(skills_root.parent / "external-src", "ext-bound")

    first = install_skill_from_directory(external, skills_root=skills_root, mode="bound")
    second = install_skill_from_directory(external, skills_root=skills_root, mode="bound")

    assert first["install_mode"] == "bound"
    assert Path(first["bound_path"]) == external.resolve()
    assert second["success"] is True
    assert second.get("already_installed") is True
    assert second["install_mode"] == "bound"
    assert external.is_dir(), "重复注册不得删除外部源目录"


def test_same_name_from_elsewhere_still_conflicts(skills_root: Path) -> None:
    from evoflow.skills.installer import SkillAlreadyExistsError, install_skill_from_directory

    _write_skill(skills_root / "custom", "dup-name")
    other = _write_skill(skills_root.parent / "other" / "dup-name", "dup-name")

    with pytest.raises(SkillAlreadyExistsError):
        install_skill_from_directory(other, skills_root=skills_root, mode="copy")
    with pytest.raises(SkillAlreadyExistsError):
        install_skill_from_directory(other, skills_root=skills_root, mode="bound")
