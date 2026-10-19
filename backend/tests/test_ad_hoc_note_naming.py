"""Ad-hoc inbox notes: slug filenames; pending notes injectable."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.assets.ad_hoc_note import (
    build_ad_hoc_filename,
    format_pending_inbox_notes_for_prompt,
    validate_ad_hoc_filename,
    write_ad_hoc_note,
)
from evoflow.assets.paths import EntityRef, entity_root
from evoflow.config.paths import reset_paths_cache


@pytest.fixture()
def asset_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    reset_paths_cache()
    yield tmp_path
    reset_paths_cache()


def test_filename_is_slug_only() -> None:
    name = build_ad_hoc_filename(slug_hint="Douyin Pipeline Fallback!")
    assert name == "douyin-pipeline-fallback.md"
    assert validate_ad_hoc_filename(name) is None
    assert validate_ad_hoc_filename("2026-10-19T15-40-00-legacy.md") is None
    assert validate_ad_hoc_filename("Bad Name.md") is not None


def test_write_and_pending_injection(asset_home: Path) -> None:
    entity = EntityRef("employee", "douyin-analyst")
    data = write_ad_hoc_note(
        entity,
        "[experience]\nimage post fallback when API timed out",
        slug_hint="douyin-pipeline-image-post-fallback",
    )
    rel = str(data.get("path") or "")
    assert Path(rel).name == "douyin-pipeline-image-post-fallback.md"
    assert (entity_root(entity) / "memory" / "_inbox" / "notes" / "douyin-pipeline-image-post-fallback.md").is_file()

    block = format_pending_inbox_notes_for_prompt(entity)
    assert "douyin-pipeline-image-post-fallback.md" in block
    assert "image post fallback" in block
