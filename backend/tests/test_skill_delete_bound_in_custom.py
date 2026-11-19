"""回归：bound 技能删除后不得「经磁盘扫描复活」。

缺陷背景（2026-11-19 实测）：in-place(bound) 注册的技能，若源目录恰好落在
生效根的 ``custom/`` 下，``skills.delete`` 只删注册表行、不删目录；下一轮
``load_skills`` 扫盘又把该目录收回来，于是「删完立刻 skills.get 还能查到」，
用户看到的是假删除。

修法：bound 分支里判断源目录是否位于生效根 ``custom/`` 之内——
在内部则连目录一起删；在生效根之外（真正的外部注册）仍保留用户源码树。
"""

from __future__ import annotations

from pathlib import Path

import pytest


def _write_skill(parent: Path, name: str) -> Path:
    skill_dir = parent / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: bound delete demo\n---\n# {name}\n",
        encoding="utf-8",
    )
    return skill_dir


@pytest.fixture()
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "skills"
    (root / "public").mkdir(parents=True)
    (root / "custom").mkdir(parents=True)
    monkeypatch.setenv("EVOFLOW_SKILLS_PATH", str(root))

    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.skills import loader

    registry: dict[str, dict] = {}

    def _upsert(name, **fields):
        meta = fields.pop("meta", None)
        row = {"name": name, **fields}
        if meta is not None:
            row["meta"] = meta
        registry[name] = row

    monkeypatch.setattr(cfg_repo, "get_skill_registry", lambda n: registry.get(n))
    monkeypatch.setattr(cfg_repo, "list_skill_registry", lambda: dict(registry))
    monkeypatch.setattr(cfg_repo, "upsert_skill_registry", _upsert)
    monkeypatch.setattr(
        cfg_repo, "delete_skill_registry", lambda n: registry.pop(n, None) is not None
    )
    monkeypatch.setattr(
        "evoflow.persistence.bootstrap.sync_skills_from_filesystem", lambda **_k: None
    )
    monkeypatch.setattr(
        "evoflow.config.extensions_config.get_extensions_config",
        lambda: type("E", (), {"skills": {}})(),
    )
    monkeypatch.setattr(
        "evoflow.config.extensions_config.save_extensions_to_db", lambda *_a, **_k: None
    )
    monkeypatch.setattr(
        "evoflow.config.extensions_config.reload_extensions_config", lambda: None
    )
    loader.clear_skills_cache()
    yield root, registry
    loader.clear_skills_cache()


def _register_bound(registry: dict, name: str, skill_dir: Path) -> None:
    registry[name] = {
        "enabled": True,
        "source_path": str(skill_dir.resolve()),
        "category": "custom",
        "meta": {"install_mode": "bound", "bound_path": str(skill_dir.resolve())},
    }


def test_delete_bound_skill_inside_custom_removes_dir_and_does_not_resurrect(env) -> None:
    root, registry = env
    from evoflow.admin import skills as skills_admin
    from evoflow.skills.loader import clear_skills_cache, load_skills

    skill_dir = _write_skill(root / "custom", "bound-inside")
    _register_bound(registry, "bound-inside", skill_dir)
    clear_skills_cache()
    assert "bound-inside" in [s.name for s in load_skills(enabled_only=False)]

    out = skills_admin.delete_skill("bound-inside")

    assert out["success"] is True
    assert out["removed_source_dir"] is True
    assert not skill_dir.exists(), "落在 custom/ 内的 bound 源目录应被删除"
    assert "bound-inside" not in registry

    clear_skills_cache()
    names = [s.name for s in load_skills(enabled_only=False)]
    assert "bound-inside" not in names, "删除后不得经磁盘扫描复活"


def test_delete_bound_skill_outside_root_keeps_source_tree(env) -> None:
    root, registry = env
    from evoflow.admin import skills as skills_admin

    external = _write_skill(root.parent / "external-src", "bound-outside")
    _register_bound(registry, "bound-outside", external)

    out = skills_admin.delete_skill("bound-outside")

    assert out["success"] is True
    assert out["removed_source_dir"] is False
    assert (external / "SKILL.md").is_file(), "生效根之外的外部源目录不得删除"
    assert "bound-outside" not in registry
