"""Tests for Asset Hub runtime-aligned search + prompt templates."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.assets.guidance import build_read_path_entity_block
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
    # M 工作树把 prompt 从 `assets(action=search|read|...)` 改为统一走 read/write/replace 工具
    # 测试据此对齐:验证引导段提到 read/write/replace 而不是 assets(action=...).
    for token in ("read", "write", "replace"):
        assert token in text, token
    assert "## Entity assets" in text
    assert "{{ layout_lines }}" not in text
    assert "MEMORY_SUMMARY BEGINS" not in text


def test_load_read_path_entity_prompt():
    text = load_memory_prompt("read_path_entity")
    # 模板字段: heading 锚点 + workspace 注入位 + catalog 行 + standing + tail(写入入口)
    for key in ("entity_root", "base_dir", "workspace_context_block",
                "catalog_lines", "memory_summary", "tail_block"):
        assert "{{ " + key + " }}" in text, key
    # 没有再保留 BEGIN/END sentinel (card 在 markdown 代码栅栏内已足够区分)
    assert "MEMORY_SUMMARY BEGINS" not in text


def test_render_read_path_fills_summary():
    from evoflow.assets.guidance import build_read_path_guidance

    out = render_memory_prompt(
        "read_path_entity",
        entity_label="User",
        entity_root="assets/user",
        base_dir="C:/Users/admin/.evoflow",
        workspace_context_block="",
        catalog_lines="- memory/MEMORY.md · (search primary)",
        memory_summary="用户喜欢简短回复",
        tail_block=(
            "写入:`assets/user/memory/_inbox/notes/<TS>-<slug>.md` · "
            "标签:`[experience]`/`[process]`/`[reflection]`/`[preference]` (首行)"
        ),
    )
    # entity_root 锚点 heading 出现一次
    assert out.count("`assets/user`") >= 1
    assert "用户喜欢简短回复" in out
    # 运行时上下文段:base_dir 在 heading 行
    assert "base=" in out
    assert "C:/Users/admin/.evoflow" in out
    # 写入入口路径(相对路径,因为 base_dir 已经给出)
    assert "memory/_inbox/notes/" in out

    composed = build_read_path_entity_block(
        EntityRef("user", "user"),
        standing="用户喜欢简短回复",
    )
    assert "用户喜欢简短回复" in composed


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
    assert "fact memory/facts/pref.md" in block
    assert '<item kind="fact"' not in block


def test_assets_tool_registered_and_kinds_work(entity_tree: EntityRef):
    from evoflow.tools.tools import BUILTIN_TOOLS

    # M 工作树已移除统一 `assets` 工具 —— 资产改走原生 read/write/replace 或 bash
    # （而非 `assets(action=search|read|...)`）。测试据此对齐。
    assert not any(getattr(t, "name", None) == "assets" for t in BUILTIN_TOOLS)
    # BUILTIN_TOOLS 仍注册了非 assets 工具用于文件系统访问(bash / read_file 等)
    names = {getattr(t, "name", None) for t in BUILTIN_TOOLS}
    has_filesystem_tool = bool({"read", "bash", "read_file"} & names)
    assert has_filesystem_tool, f"expected a filesystem tool, got: {sorted(names)[:20]}"
    res = search_entity_assets(entity_tree, ["diagnose"], kinds="facts,journal")
    assert res["matches"]
    assert all("/facts/" in m["path"] or m["path"].startswith("memory/facts/") for m in res["matches"])
