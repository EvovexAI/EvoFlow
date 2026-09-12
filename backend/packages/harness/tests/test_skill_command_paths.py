"""Tests for skill path rewriting in host-direct shell commands."""

from __future__ import annotations

import os
import tempfile

import pytest

from evoflow.tools.host_direct.skill_command_paths import rewrite_skill_paths_in_command


@pytest.fixture
def skills_root(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "skills")
        script_dir = os.path.join(root, "public", "media-production", "scripts")
        os.makedirs(script_dir)
        script = os.path.join(script_dir, "image_generate.py")
        with open(script, "w", encoding="utf-8") as fh:
            fh.write("# test\n")
        skill_md = os.path.join(root, "public", "media-production", "SKILL.md")
        with open(skill_md, "w", encoding="utf-8") as fh:
            fh.write("---\nname: media-production\ndescription: test skill\n---\n")

        import evoflow.skills.loader as loader_mod

        monkeypatch.setattr(loader_mod, "get_skills_root_path", lambda: __import__("pathlib").Path(root))

        def _host_path():
            return __import__("pathlib").Path(root)

        monkeypatch.setattr(
            "evoflow.tools.host_direct.skill_command_paths._resolve_skills_host_path",
            _host_path,
        )
        yield root, script


def test_rewrite_repo_relative_skills_path(skills_root):
    root, _script = skills_root
    cmd = (
        'python skills/public/media-production/scripts/image_generate.py '
        '--prompt "cat" --aspect-ratio 16:9 --output-dir outputs'
    )
    got = rewrite_skill_paths_in_command(cmd)
    expected = __import__("pathlib").Path(root, "public", "media-production", "scripts", "image_generate.py").resolve()
    assert str(expected) in got or expected.as_posix() in got.replace("\\", "/")
    assert "skills/public/" not in got


def test_rewrite_virtual_mnt_skills_path(skills_root):
    root, _script = skills_root
    cmd = "python /mnt/skills/public/media-production/scripts/image_generate.py --help"
    got = rewrite_skill_paths_in_command(cmd)
    expected = __import__("pathlib").Path(root, "public", "media-production", "scripts", "image_generate.py").resolve()
    assert str(expected) in got or expected.as_posix() in got.replace("\\", "/")
    assert "/mnt/skills/" not in got


def test_rewrite_windows_backslash_path(skills_root):
    root, _script = skills_root
    cmd = r"python skills\public\media-production\scripts\image_generate.py --help"
    got = rewrite_skill_paths_in_command(cmd)
    expected = __import__("pathlib").Path(root, "public", "media-production", "scripts", "image_generate.py").resolve()
    assert str(expected) in got or expected.as_posix() in got.replace("\\", "/")
    assert not got.lstrip().startswith("python skills")


def test_rewrite_userprofile_evoflow_skills_path(skills_root):
    root, _script = skills_root
    cmd = r'Get-ChildItem -Path "$env:USERPROFILE\.evoflow\skills\public\media-production\scripts"'
    got = rewrite_skill_paths_in_command(cmd)
    expected = __import__("pathlib").Path(root, "public", "media-production", "scripts").resolve()
    assert str(expected) in got or expected.as_posix() in got.replace("\\", "/")
    assert "$env:USERPROFILE\\.evoflow\\skills" not in got


def test_rewrite_skill_uri_path(skills_root, monkeypatch):
    root, script = skills_root
    import evoflow.skills.active as active_mod

    token = active_mod.set_active_skills(["media-production"])
    try:
        cmd = "python skill:media-production/scripts/image_generate.py --help"
        got = rewrite_skill_paths_in_command(cmd)
        assert str(script) in got or script.replace("\\", "/") in got.replace("\\", "/")
        assert "skill:" not in got
    finally:
        active_mod.reset_active_skills(token)


def test_rewrite_bare_scripts_with_active_skill(skills_root, monkeypatch):
    root, script = skills_root
    import evoflow.skills.active as active_mod

    token = active_mod.set_active_skills(["media-production"])
    try:
        cmd = "python scripts/image_generate.py --help"
        got = rewrite_skill_paths_in_command(cmd)
        assert str(script) in got or script.replace("\\", "/") in got.replace("\\", "/")
    finally:
        active_mod.reset_active_skills(token)


def test_no_rewrite_when_skills_root_missing(monkeypatch):
    import evoflow.skills.loader as loader_mod

    monkeypatch.setattr(
        loader_mod,
        "get_skills_root_path",
        lambda: __import__("pathlib").Path("/nonexistent/skills"),
    )
    cmd = "python skills/public/foo/scripts/bar.py"
    assert rewrite_skill_paths_in_command(cmd) == cmd
