"""L2 catalog injects basenames only (no description dump); assets read resolves them."""

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
