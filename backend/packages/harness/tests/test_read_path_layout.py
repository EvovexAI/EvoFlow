"""Compact read_path layout (root once + relative paths)."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.assets.guidance import _entity_layout_lines, build_read_path_guidance
from evoflow.assets.hub import ensure_entity_tree
from evoflow.assets.paths import EntityRef, workspace_entity_ref
from evoflow.config.memory_config import MemoryConfig, set_memory_config
from evoflow.config.paths import reset_paths_cache


@pytest.fixture
def assets_home(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_paths_cache()
        set_memory_config(MemoryConfig(injection_mode="asset"))
        yield Path(tmp)
        reset_paths_cache()
        set_memory_config(MemoryConfig())


def test_layout_lines_user_relative_only() -> None:
    lines, cross = _entity_layout_lines(EntityRef("user", "user"))
    assert "assets/user" not in lines
    assert lines.startswith("- profile/")
    assert "memory/standing.md" in lines
    assert cross == ""


def test_layout_lines_workspace_no_profile() -> None:
    lines, cross = _entity_layout_lines(workspace_entity_ref("/tmp/proj"))
    assert "profile/" not in lines
    assert "memory/facts/" in lines
    assert "assets/user/memory" in cross


def test_read_path_guidance_root_once(assets_home: Path) -> None:
    ref = workspace_entity_ref(str(assets_home / "repo"))
    ensure_entity_tree(ref)
    standing = assets_home / "assets" / "workspaces" / ref.entity_id / "memory" / "standing.md"
    standing.parent.mkdir(parents=True, exist_ok=True)
    standing.write_text("# 项目\n\nEvoFlow backend harness\n", encoding="utf-8")

    block = build_read_path_guidance(ref)
    root = f"assets/workspaces/{ref.entity_id}"
    assert block.count(root) == 1
    assert f"**Root:** `{root}/`" in block
    assert f"{root}/memory/standing.md" not in block
    assert "- memory/standing.md" in block
    assert "profile/basic-info" not in block
