"""L2 catalog injects basenames only (no description dump); assets read resolves them.

【fullstack-dev · 2026-11-14 · 第3轮】新增用例：ghost 路径（journal/<不存在名>）归一到 canonical memory/… 、
canonical 输入幂等、无关根（craft/）不重写 —— 固定住「alias 表命中 ≠ 问题解决」那个假阳性。"""

from __future__ import annotations

from pathlib import Path

from evoflow.assets.catalog import format_entity_catalog_lines, format_entity_catalog_xml
from evoflow.assets.paths import EntityRef, resolve_asset_rel


def test_catalog_lines_filename_only_no_desc(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    from evoflow.config.paths import reset_paths_cache

    reset_paths_cache()
    root = tmp_path / "assets" / "employees" / "demo"
    craft = root / "craft"
    facts = root / "memory" / "facts"
    craft.mkdir(parents=True)
    facts.mkdir(parents=True)
    (root / "memory").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "MEMORY.md").write_text("# Task Group: demo\n", encoding="utf-8")
    (craft / "five-block.md").write_text(
        "---\nname: five-block\ndescription: 五段式超长说明不要注入\n---\n\nbody\n",
        encoding="utf-8",
    )
    (facts / "pref-lang.md").write_text(
        "---\ntitle: 语言偏好\nsummary: 中文优先\n---\n\nbody\n",
        encoding="utf-8",
    )

    lines = format_entity_catalog_lines(EntityRef("employee", "demo"))
    text = "\n".join(lines)
    assert "- MEMORY.md" in text
    assert "craft · 经验/做法:" in text
    assert "- five-block.md" in text
    assert "五段式" not in text
    # facts retired from the lines listing (product IA no longer surfaces them)
    assert "语言偏好" not in text
    assert "craft/five-block.md" not in text
    assert "memory/facts/pref-lang.md" not in text

    xml = format_entity_catalog_xml(EntityRef("employee", "demo"), include_standing=False)
    assert "summary MEMORY.md" in xml
    assert "craft · 经验/做法:" in xml
    assert "- five-block.md" in xml
    assert "fact · 事实:" in xml
    assert "- pref-lang.md" in xml
    assert "五段式" not in xml
    assert "语言偏好" not in xml
    assert "craft/five-block.md" not in xml
    assert "memory/facts/" not in xml


def test_resolve_asset_rel_basename(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    from evoflow.config.paths import reset_paths_cache

    reset_paths_cache()
    root = tmp_path / "assets" / "employees" / "demo"
    craft = root / "craft"
    craft.mkdir(parents=True)
    (craft / "five-block.md").write_text("# ok\n", encoding="utf-8")
    ent = EntityRef("employee", "demo")

    assert resolve_asset_rel(ent, "five-block.md") == "craft/five-block.md"
    assert resolve_asset_rel(ent, "craft/five-block.md") == "craft/five-block.md"
    assert resolve_asset_rel(ent, "_inbox/notes/x.md") == "memory/_inbox/notes/x.md"


def test_resolve_asset_rel_kind_prefix_falls_back_to_memory(tmp_path: Path, monkeypatch) -> None:
    """``journal/x.md`` must reach the real file at ``memory/journal/x.md``.

    Without the existence-aware fallback the literal path is returned and the
    caller dies on ``not_found`` — the exact split-brain reported in-session.
    Idempotence for already-correct paths must hold.
    """
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    from evoflow.config.paths import reset_paths_cache

    reset_paths_cache()
    root = tmp_path / "assets" / "employees" / "demo"
    journal = root / "memory" / "journal"
    journal.mkdir(parents=True)
    (journal / "note-1.md").write_text("# note 1\n", encoding="utf-8")
    ent = EntityRef("employee", "demo")

    # shortcut form resolves to the existing file
    assert resolve_asset_rel(ent, "journal/note-1.md") == "memory/journal/note-1.md"
    # canonical form is untouched (idempotent)
    assert resolve_asset_rel(ent, "memory/journal/note-1.md") == "memory/journal/note-1.md"
    # non-existent target keeps the canonicalized literal (caller reports not_found)
    assert resolve_asset_rel(ent, "journal/ghost.md") == "memory/journal/ghost.md"
    # unrelated roots are never rewritten
    assert resolve_asset_rel(ent, "craft/five-block.md") == "craft/five-block.md"
