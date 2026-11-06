"""Catalog must inject even when standing is a placeholder template."""

from __future__ import annotations

from pathlib import Path

from evoflow.assets.guidance import build_entity_memory_injection
from evoflow.assets.paths import EntityRef


def test_placeholder_standing_still_injects_catalog(tmp_path: Path, monkeypatch) -> None:
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
    assert block.strip(), "entity injection must not be empty when catalog has files"
    assert "demo-recipe.md" in block
    assert "catalog" in block.lower() or "经验" in block
