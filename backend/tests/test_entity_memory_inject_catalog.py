"""Catalog filenames inject (L2 index); the standing body stays on-demand on disk."""

from __future__ import annotations

from pathlib import Path

from evoflow.assets.guidance import build_entity_memory_injection
from evoflow.assets.paths import EntityRef


def test_entity_injection_has_catalog_filenames_but_no_standing_body(tmp_path: Path, monkeypatch) -> None:
    """Catalog filenames inject so the model knows which assets exist; standing body stays on disk."""
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    from evoflow.config.paths import reset_paths_cache

    reset_paths_cache()

    root = tmp_path / "assets" / "employees" / "catalog-keep"
    craft = root / "craft"
    craft.mkdir(parents=True)
    (root / "memory").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "standing.md").write_text(
        "v1\n# 站立摘要\n（会话冻结的近期关注，≤400 字；第一行保留 v1 以与原生运行时一致 summary schema）\n",
        encoding="utf-8",
    )
    (craft / "demo-recipe.md").write_text(
        "---\ntitle: Demo recipe\ndescription: keep me in catalog\n---\n\n# Demo recipe\n\nsteps\n",
        encoding="utf-8",
    )

    block = build_entity_memory_injection(EntityRef("employee", "catalog-keep"))
    assert block.strip(), "entity injection must not be empty — it points at the asset root"
    # Catalog filenames inject (L2 index, basenames only).
    assert "demo-recipe.md" in block
    assert "MEMORY.md" in block
    # Descriptions/titles still stay out — filenames only.
    assert "keep me in catalog" not in block
    assert "Demo recipe" not in block
    # But the standing body stays on disk (on-demand read).
    assert "站立摘要" not in block
    assert "会话冻结的近期关注" not in block
    # And it still tells the model where assets live and how to reach them.
    assert "assets" in block.lower()
    assert "catalog-keep" in block
