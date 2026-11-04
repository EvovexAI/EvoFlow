"""Ad-hoc inbox notes: slug filenames; pending notes injectable."""

from __future__ import annotations

from pathlib import Path

import pytest

from datetime import datetime

from evoflow.assets.ad_hoc_note import (
    build_ad_hoc_filename,
    ensure_body_recorded_at,
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


def test_ensure_body_recorded_at_fills_when_missing() -> None:
    when = datetime(2026, 3, 23, 16, 38)
    out = ensure_body_recorded_at(
        "[experience] 登录失败·token 过期\n\n先刷新 token 再重试。",
        when=when,
    )
    assert out.startswith("[experience] 登录失败·token 过期\n记录时间：2026-03-23 16:38\n")
    assert "先刷新 token" in out
    # idempotent
    again = ensure_body_recorded_at(out, when=when)
    assert again.count("记录时间：") == 1


def test_ensure_body_recorded_at_skips_when_model_wrote_date() -> None:
    src = "[process] 周报\n\n日期：2026-03-20\n\n写完了。"
    assert ensure_body_recorded_at(src) == src


def test_live_pending_inbox_for_user_principal(asset_home: Path) -> None:
    from evoflow.assets.ad_hoc_note import format_live_pending_inbox_for_agent

    # Main-chat notes land in the user bucket; live helper must resolve via principal_id.
    entity = EntityRef("user", "u_live_note")
    write_ad_hoc_note(entity, "[process] mid-chat note\n\nbody", slug_hint="mid-chat-note")
    block = format_live_pending_inbox_for_agent(principal_id="u_live_note")
    assert "mid-chat-note.md" in block
    assert "mid-chat note" in block or "body" in block


def test_write_and_pending_injection(asset_home: Path) -> None:
    entity = EntityRef("employee", "douyin-analyst")
    data = write_ad_hoc_note(
        entity,
        "[experience]\nimage post fallback when API timed out",
        slug_hint="douyin-pipeline-image-post-fallback",
    )
    rel = str(data.get("path") or "")
    assert Path(rel).name == "douyin-pipeline-image-post-fallback.md"
    path = entity_root(entity) / "memory" / "_inbox" / "notes" / "douyin-pipeline-image-post-fallback.md"
    assert path.is_file()
    text = path.read_text(encoding="utf-8")
    assert "created:" in text
    assert "记录时间：" in text

    block = format_pending_inbox_notes_for_prompt(entity)
    assert "douyin-pipeline-image-post-fallback.md" in block
    assert "image post fallback" in block


def test_pending_inbox_keeps_full_note_body_by_default(asset_home: Path) -> None:
    entity = EntityRef("user", "u_trunc")
    long = (
        "[process] AIGC 反推师并入复刻师。"
        "依据（可复用判断法）：项目侧自证：`aigc/aigc-prompt-reverser` 与 `aigc-remaker` "
        "能力完全重叠，反推只是复刻 SOP 的第一步子步骤，因此删除反推师岗位。"
        + ("补充说明。" * 40)
    )
    write_ad_hoc_note(entity, long, slug_hint="aigc-merge")
    block = format_pending_inbox_notes_for_prompt(entity)
    assert "aigc-merge.md" in block
    assert "aigc/aigc-prompt-reverser" in block
    assert "补充说明。" in block
    # Explicit budget still truncates with a marker (opt-in only).
    capped = format_pending_inbox_notes_for_prompt(entity, max_chars=120)
    assert "pending inbox truncated" in capped
