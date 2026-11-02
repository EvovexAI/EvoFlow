"""CLI should resolve the same profile home as the desktop panel."""

from __future__ import annotations

from pathlib import Path

import evoflow.config.data_paths as data_paths
import evoflow.config.paths as paths_mod


def _isolate_home(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("EVOFLOW_HOME", raising=False)
    monkeypatch.delenv("EVOFLOW_PROFILE", raising=False)
    paths_mod.reset_paths_cache()


def test_resolve_profile_home_prefers_default(tmp_path: Path, monkeypatch):
    shared = tmp_path / ".evoflow"
    (shared / "profiles" / "default" / "data" / "app").mkdir(parents=True)
    (shared / "data" / "app").mkdir(parents=True)
    _isolate_home(tmp_path, monkeypatch)

    assert data_paths.resolve_active_profile_id(shared) == "default"
    assert data_paths.resolve_profile_home(shared) == (shared / "profiles" / "default").resolve()
    assert data_paths.prefer_profile_base_dir(shared) == (shared / "profiles" / "default").resolve()


def test_resolve_profile_honors_env_profile(tmp_path: Path, monkeypatch):
    shared = tmp_path / ".evoflow"
    (shared / "profiles" / "work").mkdir(parents=True)
    (shared / "profiles" / "default").mkdir(parents=True)
    monkeypatch.setenv("EVOFLOW_PROFILE", "work")
    assert data_paths.resolve_active_profile_id(shared) == "work"
    assert data_paths.resolve_profile_home(shared) == (shared / "profiles" / "work").resolve()


def test_paths_base_dir_follows_profile_when_home_unset(tmp_path: Path, monkeypatch):
    shared = tmp_path / ".evoflow"
    profile = shared / "profiles" / "default"
    (profile / "data" / "app").mkdir(parents=True)
    (shared / "data" / "app").mkdir(parents=True)
    _isolate_home(tmp_path, monkeypatch)

    p = paths_mod.Paths()
    assert p.base_dir == profile.resolve()


def test_explicit_evoflow_home_still_wins(tmp_path: Path, monkeypatch):
    shared = tmp_path / ".evoflow"
    (shared / "profiles" / "default").mkdir(parents=True)
    explicit = tmp_path / "custom-home"
    explicit.mkdir()
    _isolate_home(tmp_path, monkeypatch)
    monkeypatch.setenv("EVOFLOW_HOME", str(explicit))
    paths_mod.reset_paths_cache()

    p = paths_mod.Paths()
    assert p.base_dir == explicit.resolve()
