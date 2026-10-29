"""In-place (bound) skill registration: stay on disk, resolve skill:<name>/…."""

from __future__ import annotations

from pathlib import Path

import pytest


def _write_skill(skill_dir: Path, name: str = "demo-bound") -> Path:
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: bound demo\n---\n# {name}\n",
        encoding="utf-8",
    )
    (skill_dir / "scripts").mkdir(exist_ok=True)
    (skill_dir / "scripts" / "run.py").write_text("print('ok')\n", encoding="utf-8")
    return skill_dir


def test_register_bound_keeps_source_and_resolves_uri(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    primary = tmp_path / "skills"
    (primary / "public").mkdir(parents=True)
    (primary / "custom").mkdir(parents=True)
    monkeypatch.setenv("EVOFLOW_SKILLS_PATH", str(primary))

    # Authoritative tree lives outside skills/custom (e.g. D:/demo/…).
    source = _write_skill(tmp_path / "elsewhere" / "demo-bound")

    registry: dict = {}

    def _upsert(name, *, enabled, skill_md=None, source_path=None, category=None, meta=None, **_kw):
        registry[name] = {
            "enabled": enabled,
            "skill_md": skill_md,
            "source_path": source_path,
            "category": category,
            "meta": meta or {},
        }

    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.skills import loader
    from evoflow.skills.installer import register_skill_from_directory
    from evoflow.skills.skill_uri import resolve_skill_uri, resolve_skill_workdir

    monkeypatch.setattr(cfg_repo, "upsert_skill_registry", _upsert)
    monkeypatch.setattr(cfg_repo, "list_skill_registry", lambda: dict(registry))
    monkeypatch.setattr(cfg_repo, "get_skill_registry", lambda name: registry.get(name))
    monkeypatch.setattr(
        "evoflow.persistence.bootstrap.sync_skills_from_filesystem", lambda: None
    )
    monkeypatch.setattr(
        "evoflow.skills.security.scan_skill_directory", lambda _p: []
    )
    monkeypatch.setattr(loader, "_skills_cache", None)
    monkeypatch.setattr(loader, "_plugin_state_sig", None)
    monkeypatch.setattr(
        "evoflow.plugins.runtime.plugin_skill_roots", lambda storage_root=None: []
    )

    result = register_skill_from_directory(source, skills_root=primary)
    assert result["install_mode"] == "bound"
    assert Path(result["bound_path"]) == source.resolve()
    # Source untouched; nothing copied under custom/.
    assert not (primary / "custom" / "demo-bound").exists()
    assert (source / "SKILL.md").is_file()

    meta = registry["demo-bound"]["meta"]
    assert meta["install_mode"] == "bound"
    assert Path(registry["demo-bound"]["source_path"]) == source.resolve()

    loader.clear_skills_cache()
    from evoflow.skills.loader import find_skill_directory, load_skills

    skills = load_skills(enabled_only=False, use_config=True)
    hit = next(s for s in skills if s.name == "demo-bound")
    assert hit.skill_dir.resolve() == source.resolve()
    assert hit.category == "custom"

    assert find_skill_directory("demo-bound") == source.resolve()
    assert resolve_skill_workdir("skill:demo-bound") == source.resolve()
    script = resolve_skill_uri("skill:demo-bound/scripts/run.py")
    assert script is not None
    assert script.resolve() == (source / "scripts" / "run.py").resolve()

    from evoflow.skills.skill_uri import resolve_skill_path_for_command
    from evoflow.tools.host_direct.skill_command_paths import rewrite_skill_paths_in_command

    # bash path rewrite: skill root + script file (not SKILL.md-only).
    assert resolve_skill_path_for_command("skill:demo-bound") == source.resolve()
    assert resolve_skill_path_for_command("skill:demo-bound/scripts") == (source / "scripts").resolve()
    rewritten = rewrite_skill_paths_in_command("python skill:demo-bound/scripts/run.py")
    assert str(source / "scripts" / "run.py") in rewritten
    assert "skill:demo-bound" not in rewritten


def test_delete_bound_unregisters_without_deleting_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    primary = tmp_path / "skills"
    (primary / "custom").mkdir(parents=True)
    monkeypatch.setenv("EVOFLOW_SKILLS_PATH", str(primary))
    source = _write_skill(tmp_path / "keep-me" / "demo-bound")

    registry = {
        "demo-bound": {
            "enabled": True,
            "source_path": str(source.resolve()),
            "category": "custom",
            "meta": {"install_mode": "bound", "bound_path": str(source.resolve())},
        }
    }

    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.skills import loader
    from evoflow.skills.bound import parse_bound_skill
    from evoflow.admin import skills as skills_admin

    monkeypatch.setattr(cfg_repo, "list_skill_registry", lambda: dict(registry))
    monkeypatch.setattr(cfg_repo, "get_skill_registry", lambda name: registry.get(name))
    monkeypatch.setattr(
        cfg_repo,
        "delete_skill_registry",
        lambda name: registry.pop(name, None) is not None,
    )
    monkeypatch.setattr(
        "evoflow.persistence.bootstrap.sync_skills_from_filesystem", lambda: None
    )
    monkeypatch.setattr(loader, "_skills_cache", None)

    bound = parse_bound_skill(source)
    assert bound is not None
    monkeypatch.setattr(skills_admin, "_find_skill", lambda _n: bound)
    monkeypatch.setattr(skills_admin, "_resolve_skills_base_path", lambda: primary)
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

    out = skills_admin.delete_skill("demo-bound")
    assert out["install_mode"] == "bound"
    assert "demo-bound" not in registry
    assert (source / "SKILL.md").is_file()
