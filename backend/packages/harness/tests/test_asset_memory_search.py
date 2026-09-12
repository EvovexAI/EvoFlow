"""Tests for Asset Hub runtime-aligned search + prompt templates."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.assets.hub import ensure_entity_tree
from evoflow.assets.paths import EntityRef
from evoflow.assets.prompt_templates import load_memory_prompt, render_memory_prompt
from evoflow.assets.search import MatchMode, search_entity_assets
from evoflow.config.paths import reset_paths_cache


@pytest.fixture
def assets_home(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_paths_cache()
        yield Path(tmp)
        reset_paths_cache()


@pytest.fixture()
def entity_tree(assets_home: Path) -> EntityRef:
    ref = EntityRef("user", "user").normalized()
    ensure_entity_tree(ref)
    mem = assets_home / "assets" / "user" / "memory"
    (mem / "MEMORY.md").write_text(
        "# Task Group: ci\n\nkeywords: cargo, cache\n\n## Reusable knowledge\n\n- use rebase not merge\n",
        encoding="utf-8",
    )
    (mem / "facts" / "pref.md").write_text(
        "---\ntitle: 偏好\nsummary: 先诊断再改\n---\n\nwhen tests fail, diagnose first\n",
        encoding="utf-8",
    )
    (mem / "episodic" / "2026-08-25-ci.md").write_text(
        "---\ntitle: CI 缓存\nsummary: 修好缓存键\n---\n\ncargo build --features ci\n",
        encoding="utf-8",
    )
    return ref


def test_load_read_path_prompt():
    text = load_memory_prompt("read_path")
    assert "assets(action=search" in text
    assert "MEMORY_SUMMARY BEGINS" in text
    assert "{{ layout_lines }}" in text
    assert "**Root:**" in text


def test_render_read_path_fills_summary():
    from evoflow.assets.guidance import _entity_layout_lines

    layout_lines, cross = _entity_layout_lines(EntityRef("user", "user"))
    out = render_memory_prompt(
        "read_path",
        entity_root="assets/user",
        layout_lines=layout_lines,
        cross_entity_note=cross,
        memory_summary="用户喜欢简短回复",
    )
    assert "assets/user" in out
    assert out.count("assets/user") == 1
    assert "- memory/standing.md" in out
    assert "用户喜欢简短回复" in out
    assert "MEMORY_SUMMARY BEGINS" in out


def test_search_any_mode(entity_tree: EntityRef):
    res = search_entity_assets(entity_tree, ["rebase"], max_results=10)
    assert res["matches"], res
    paths = {m["path"] for m in res["matches"]}
    assert any(p.endswith("MEMORY.md") for p in paths)


def test_search_all_on_same_line(entity_tree: EntityRef):
    res = search_entity_assets(
        entity_tree,
        ["cargo", "cache"],
        match_mode=MatchMode.ALL_ON_SAME_LINE,
    )
    assert res["matches"]


def test_search_skips_inbox_by_default(entity_tree: EntityRef, assets_home: Path):
    inbox = assets_home / "assets" / "user" / "memory" / "_inbox" / "notes"
    inbox.mkdir(parents=True, exist_ok=True)
    (inbox / "secret-note.md").write_text("unique-inbox-token-xyz", encoding="utf-8")
    res = search_entity_assets(entity_tree, ["unique-inbox-token-xyz"])
    assert not res["matches"]
    res2 = search_entity_assets(entity_tree, ["unique-inbox-token-xyz"], include_inbox=True)
    assert res2["matches"]


def test_search_kinds_scopes_to_facts(entity_tree: EntityRef):
    res = search_entity_assets(entity_tree, ["diagnose"], kinds="facts")
    assert res["matches"]
    assert all("facts" in m["path"] for m in res["matches"])


def test_search_kinds_excludes_other_family(entity_tree: EntityRef):
    res = search_entity_assets(entity_tree, ["rebase"], kinds="episodic")
    assert not res["matches"]
    res2 = search_entity_assets(entity_tree, ["rebase"], kinds="handbook")
    assert res2["matches"]


def test_format_entity_catalog_uses_markdown_table(entity_tree: EntityRef) -> None:
    from evoflow.assets.catalog import format_entity_catalog_xml

    block = format_entity_catalog_xml(entity_tree, include_standing=False)
    assert "<catalog>" in block
    assert "f memory/facts/pref.md" in block
    assert '<item kind="fact"' not in block


def test_assets_tool_registered_and_kinds_work(entity_tree: EntityRef):
    from evoflow.tools.tools import BUILTIN_TOOLS

    assert any(getattr(t, "name", None) == "assets" for t in BUILTIN_TOOLS)
    res = search_entity_assets(entity_tree, ["diagnose"], kinds="facts,journal")
    assert res["matches"]
    assert all("/facts/" in m["path"] or m["path"].startswith("memory/facts/") for m in res["matches"])
