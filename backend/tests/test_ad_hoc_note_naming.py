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
        "image post fallback when API timed out",
        kind="experience",
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
        "AIGC 反推师并入复刻师。\n\n依据细节。",
        kind="process",
        slug_hint="aigc-merge",
    )
    assert data.get("kind") == "episodic"
    rel = str(data.get("path") or "").replace("\\", "/")
    assert "memory/episodic/" in rel
    assert (entity_root(entity) / rel).is_file()


def test_process_same_title_creates_new_without_update_path(asset_home: Path) -> None:
    """Runtime must not auto-merge by title; only explicit update_path overwrites."""
    entity = EntityRef("user", "u_upd")
    first = write_ad_hoc_note(
        entity,
        "登录失败 token 过期\n\n旧方案：手动刷新。",
        kind="process",
        slug_hint="登录失败-token-过期",
    )
    rel1 = str(first.get("path") or "").replace("\\", "/")
    second = write_ad_hoc_note(
        entity,
        "登录失败 token 过期\n\n新方案：自动刷新后再重试。",
        kind="process",
        slug_hint="登录失败-token-过期",
    )
    rel2 = str(second.get("path") or "").replace("\\", "/")
    assert rel1 != rel2
    assert second.get("updated") is not True
    episodic = entity_root(entity) / "memory" / "episodic"
    assert len(list(episodic.glob("*.md"))) == 2


def test_process_update_path_overwrites(asset_home: Path) -> None:
    entity = EntityRef("user", "u_path")
    first = write_ad_hoc_note(
        entity,
        "登录失败 token 过期\n\n旧方案：手动刷新。",
        kind="process",
        slug_hint="登录失败-token-过期",
    )
    rel = str(first.get("path") or "").replace("\\", "/")
    second = write_ad_hoc_note(
        entity,
        "登录失败 token 过期\n\n新方案：自动刷新后再重试。",
        kind="process",
        update_path=rel,
    )
    assert str(second.get("path") or "").replace("\\", "/") == rel
    assert second.get("updated") is True
    text = (entity_root(entity) / rel).read_text(encoding="utf-8")
    assert "自动刷新" in text
    assert "手动刷新" not in text
    assert len(list((entity_root(entity) / "memory" / "episodic").glob("*.md"))) == 1


def test_craft_update_path_overwrites(asset_home: Path) -> None:
    entity = EntityRef("employee", "ops")
    first = write_ad_hoc_note(
        entity,
        "图片发帖 API 超时 fallback\n\n旧：直接失败。",
        kind="experience",
        slug_hint="图片发帖-api-超时-fallback",
    )
    rel = str(first.get("path") or "").replace("\\", "/")
    second = write_ad_hoc_note(
        entity,
        "图片发帖 API 超时 fallback\n\n新：改走本地缓存重试。",
        kind="experience",
        update_path=rel,
    )
    assert second.get("updated") is True
    assert str(second.get("path") or "").replace("\\", "/") == rel
    assert "本地缓存" in (entity_root(entity) / rel).read_text(encoding="utf-8")


def test_preference_appends_without_replace(asset_home: Path) -> None:
    entity = EntityRef("user", "u_pref")
    write_ad_hoc_note(entity, "默认用中文回复，简短结论先行。", kind="preference")
    second = write_ad_hoc_note(entity, "默认用中文回复，先给结论再展开细节。", kind="preference")
    assert second.get("updated") is not True
    standing = (entity_root(entity) / "memory" / "standing.md").read_text(encoding="utf-8")
    assert "简短结论先行" in standing
    assert "先给结论再展开" in standing


def test_preference_mode_replace_overwrites_standing(asset_home: Path) -> None:
    entity = EntityRef("user", "u_pref2")
    write_ad_hoc_note(entity, "旧偏好一条。", kind="preference")
    second = write_ad_hoc_note(
        entity,
        "v1\n\n## User preferences\n\n- 只要这一条新偏好。\n",
        kind="preference",
        mode="replace",
    )
    assert second.get("updated") is True
    standing = (entity_root(entity) / "memory" / "standing.md").read_text(encoding="utf-8")
    assert "只要这一条新偏好" in standing
    assert "旧偏好一条" not in standing
