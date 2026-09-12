"""Tests for ~/.evoflow/skills public sync and custom preservation."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from evoflow.skills.user_install import (
    ensure_user_skills_install,
    get_user_skills_root,
    sync_system_public_skills,
)


@pytest.fixture
def user_home(monkeypatch, tmp_path: Path):
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.delenv("EVOFLOW_SKILLS_PATH", raising=False)
    monkeypatch.setattr(Path, "home", staticmethod(lambda: home))
    return home


def test_sync_public_copies_to_user_dir(user_home, tmp_path: Path, monkeypatch):
    source = tmp_path / "repo-skills"
    (source / "public" / "demo-skill").mkdir(parents=True)
    (source / "public" / "demo-skill" / "SKILL.md").write_text("# demo\n", encoding="utf-8")
    (source / "public" / "demo-skill" / "scripts").mkdir(parents=True)
    (source / "public" / "demo-skill" / "scripts" / "run.py").write_text("print('ok')\n", encoding="utf-8")

    user_skills = get_user_skills_root()
    changed = sync_system_public_skills(skills_root=user_skills, source=source, force=True)
    assert changed is True
    assert (user_skills / "public" / "demo-skill" / "SKILL.md").is_file()
    assert (user_skills / "public" / "demo-skill" / "scripts" / "run.py").read_text(encoding="utf-8") == "print('ok')\n"


def test_sync_public_preserves_custom(user_home, tmp_path: Path):
    source = tmp_path / "repo-skills"
    (source / "public" / "sys-skill").mkdir(parents=True)
    (source / "public" / "sys-skill" / "SKILL.md").write_text("# sys\n", encoding="utf-8")

    user_skills = get_user_skills_root()
    (user_skills / "custom" / "my-skill").mkdir(parents=True)
    (user_skills / "custom" / "my-skill" / "SKILL.md").write_text("# mine\n", encoding="utf-8")

    sync_system_public_skills(skills_root=user_skills, source=source, force=True)
    assert (user_skills / "custom" / "my-skill" / "SKILL.md").read_text(encoding="utf-8") == "# mine\n"
    assert (user_skills / "public" / "sys-skill" / "SKILL.md").is_file()


def test_sync_public_removes_obsolete_system_skill(user_home, tmp_path: Path):
    source = tmp_path / "repo-skills"
    (source / "public" / "kept").mkdir(parents=True)
    (source / "public" / "kept" / "SKILL.md").write_text("# kept\n", encoding="utf-8")

    user_skills = get_user_skills_root()
    (user_skills / "public" / "removed").mkdir(parents=True)
    (user_skills / "public" / "removed" / "SKILL.md").write_text("# old\n", encoding="utf-8")

    sync_system_public_skills(skills_root=user_skills, source=source, force=True)
    assert (user_skills / "public" / "kept" / "SKILL.md").is_file()
    assert not (user_skills / "public" / "removed").exists()


def test_sync_skips_when_unchanged(user_home, tmp_path: Path):
    source = tmp_path / "repo-skills"
    (source / "public" / "demo").mkdir(parents=True)
    (source / "public" / "demo" / "SKILL.md").write_text("# demo\n", encoding="utf-8")

    user_skills = get_user_skills_root()
    assert sync_system_public_skills(skills_root=user_skills, source=source, force=True) is True
    assert sync_system_public_skills(skills_root=user_skills, source=source, force=False) is False


def test_sync_skips_packaged_manifest_without_content_rescan(user_home, tmp_path: Path, monkeypatch):
    import evoflow.skills.user_install as ui

    source = tmp_path / "repo-skills"
    (source / "public" / "demo" / "SKILL.md").parent.mkdir(parents=True)
    (source / "public" / "demo" / "SKILL.md").write_text("# demo\n", encoding="utf-8")

    user_skills = get_user_skills_root()
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(ui, "_install_fingerprint", lambda _src: "frozen|pkg.exe|size=1|mtime_ns=1")

    assert sync_system_public_skills(skills_root=user_skills, source=source, force=True) is True
    (source / "public" / "demo" / "SKILL.md").write_text("# changed on disk\n", encoding="utf-8")
    assert sync_system_public_skills(skills_root=user_skills, source=source, force=False) is False
    assert (user_skills / "public" / "demo" / "SKILL.md").read_text(encoding="utf-8") == "# demo\n"

def test_sync_dev_quick_stats_detects_skill_edit(user_home, tmp_path: Path, monkeypatch):
    import evoflow.skills.user_install as ui

    source = tmp_path / "repo-skills"
    skill_md = source / "public" / "demo" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("# v1\n", encoding="utf-8")

    user_skills = get_user_skills_root()
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    monkeypatch.setattr(ui, "_install_fingerprint", lambda _src: f"dev|{source.resolve()}")

    assert sync_system_public_skills(skills_root=user_skills, source=source, force=True) is True
    skill_md.write_text("# v2\n", encoding="utf-8")
    assert sync_system_public_skills(skills_root=user_skills, source=source, force=False) is True
    assert (user_skills / "public" / "demo" / "SKILL.md").read_text(encoding="utf-8") == "# v2\n"


def test_bootstrap_skills_path_deferred_when_populated(user_home, tmp_path: Path, monkeypatch):
    import evoflow.skills.user_install as ui

    source = tmp_path / "repo-skills"
    (source / "public" / "demo" / "SKILL.md").parent.mkdir(parents=True)
    (source / "public" / "demo" / "SKILL.md").write_text("# demo\n", encoding="utf-8")

    user_skills = get_user_skills_root()
    monkeypatch.setattr(ui, "resolve_system_skills_source", lambda: source.resolve())
    sync_called = {"n": 0}
    orig_sync = ui.sync_system_public_skills

    def _count_sync(**kwargs):
        sync_called["n"] += 1
        return orig_sync(**kwargs)

    monkeypatch.setattr(ui, "sync_system_public_skills", _count_sync)

    # Pre-populate destination (simulates prior install)
    dest = user_skills / "public" / "demo" / "SKILL.md"
    dest.parent.mkdir(parents=True)
    dest.write_text("# old\n", encoding="utf-8")

    root = ui.bootstrap_user_skills_path()
    assert root == user_skills
    assert sync_called["n"] == 0
    assert os.environ.get("EVOFLOW_SKILLS_PATH") == str(user_skills)


def test_sync_updates_when_skill_content_changes(user_home, tmp_path: Path):
    source = tmp_path / "repo-skills"
    skill_md = source / "public" / "demo" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("# v1\n", encoding="utf-8")
    # A second file with a newer mtime used to mask SKILL.md edits in the old signature.
    other = source / "public" / "demo" / "scripts" / "run.py"
    other.parent.mkdir(parents=True)
    other.write_text("print('v1')\n", encoding="utf-8")

    user_skills = get_user_skills_root()
    assert sync_system_public_skills(skills_root=user_skills, source=source, force=True) is True

    skill_md.write_text("# v2\n", encoding="utf-8")
    assert sync_system_public_skills(skills_root=user_skills, source=source, force=False) is True
    assert (user_skills / "public" / "demo" / "SKILL.md").read_text(encoding="utf-8") == "# v2\n"


def test_sync_overwrites_stale_cache_even_when_local_mtime_is_newer(user_home, tmp_path: Path):
    source = tmp_path / "repo-skills"
    skill_md = source / "public" / "demo" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("# bundled\n", encoding="utf-8")

    user_skills = get_user_skills_root()
    sync_system_public_skills(skills_root=user_skills, source=source, force=True)

    cached = user_skills / "public" / "demo" / "SKILL.md"
    cached.write_text("# stale local\n", encoding="utf-8")
    now_ns = 2_000_000_000
    os.utime(cached, ns=(now_ns, now_ns))

    skill_md.write_text("# bundled v2\n", encoding="utf-8")
    os.utime(skill_md, ns=(1_000_000_000, 1_000_000_000))

    assert sync_system_public_skills(skills_root=user_skills, source=source, force=False) is True
    assert cached.read_text(encoding="utf-8") == "# bundled v2\n"


def test_sync_runs_when_install_fingerprint_changes(user_home, tmp_path: Path, monkeypatch):
    import evoflow.skills.user_install as ui

    source = tmp_path / "repo-skills"
    (source / "public" / "demo" / "SKILL.md").parent.mkdir(parents=True)
    (source / "public" / "demo" / "SKILL.md").write_text("# demo\n", encoding="utf-8")

    user_skills = get_user_skills_root()
    assert sync_system_public_skills(skills_root=user_skills, source=source, force=True) is True
    assert sync_system_public_skills(skills_root=user_skills, source=source, force=False) is False

    monkeypatch.setattr(
        ui,
        "_install_fingerprint",
        lambda _source_root: "frozen|upgraded.exe|size=999|mtime_ns=999",
    )
    assert sync_system_public_skills(skills_root=user_skills, source=source, force=False) is True


def test_ensure_user_skills_install_sets_env(user_home, tmp_path: Path, monkeypatch):
    source = tmp_path / "repo-skills"
    (source / "public" / "demo-skill").mkdir(parents=True)
    (source / "public" / "demo-skill" / "SKILL.md").write_text("# demo\n", encoding="utf-8")

    import evoflow.skills.user_install as ui

    monkeypatch.setattr(ui, "resolve_system_skills_source", lambda: source.resolve())

    got = ensure_user_skills_install(force_sync=True)
    user_skills = get_user_skills_root()
    assert got == user_skills
    assert (user_skills / "public" / "demo-skill" / "SKILL.md").is_file()
    import os

    assert os.environ.get("EVOFLOW_SKILLS_PATH") == str(user_skills)


def test_ensure_user_skills_respects_explicit_env(monkeypatch, tmp_path: Path):
    explicit = tmp_path / "custom-skills"
    (explicit / "public").mkdir(parents=True)
    monkeypatch.setenv("EVOFLOW_SKILLS_PATH", str(explicit))
    got = ensure_user_skills_install()
    assert got == explicit.resolve()
