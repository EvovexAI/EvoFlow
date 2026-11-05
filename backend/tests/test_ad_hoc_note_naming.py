"""Ad-hoc notes: slug helpers + direct-write by tag (no inbox hop)."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest

from evoflow.assets.ad_hoc_note import (
    build_ad_hoc_filename,
    ensure_body_recorded_at,
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


def test_ensure_body_recorded_at_fills_when_missing() -> None:
    when = datetime(2026, 3, 23, 16, 38)
    out = ensure_body_recorded_at(
        "[experience] 登录失败·token 过期\n\n先刷新 token 再重试。",
        when=when,
    )
    assert out.startswith("[experience] 登录失败·token 过期\n记录时间：2026-03-23 16:38\n")
    assert "先刷新 token" in out
    again = ensure_body_recorded_at(out, when=when)
    assert again.count("记录时间：") == 1


def test_ensure_body_recorded_at_skips_when_model_wrote_date() -> None:
    src = "[process] 周报\n\n日期：2026-03-20\n\n写完了。"
    assert ensure_body_recorded_at(src) == src


def test_experience_writes_craft_directly(asset_home: Path) -> None:
    entity = EntityRef("employee", "douyin-analyst")
    data = write_ad_hoc_note(
        entity,
        "[experience]\nimage post fallback when API timed out",
        slug_hint="douyin-pipeline-image-post-fallback",
    )
    assert data.get("kind") == "craft"
    rel = str(data.get("path") or "").replace("\\", "/")
    assert rel.startswith("craft/")
    path = entity_root(entity) / rel
    assert path.is_file()
    text = path.read_text(encoding="utf-8")
    assert "image post fallback" in text or "记录时间" in text
    inbox = entity_root(entity) / "memory" / "_inbox" / "notes"
    assert not inbox.exists() or not any(inbox.glob("*.md"))


def test_process_writes_episodic_directly(asset_home: Path) -> None:
    entity = EntityRef("user", "u_trunc")
    data = write_ad_hoc_note(
        entity,
        "[process] AIGC 反推师并入复刻师。\n\n依据细节。",
        slug_hint="aigc-merge",
    )
    assert data.get("kind") == "episodic"
    rel = str(data.get("path") or "").replace("\\", "/")
    assert "memory/episodic/" in rel
    assert (entity_root(entity) / rel).is_file()
