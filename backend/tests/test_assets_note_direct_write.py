"""assets note writes directly by tag — no inbox hop."""

from __future__ import annotations

from pathlib import Path

from evoflow.assets import paths as assets_paths
from evoflow.assets.ad_hoc_note import parse_note_tag, write_ad_hoc_note
from evoflow.assets.paths import EntityRef


def test_parse_note_tag_defaults_process() -> None:
    assert parse_note_tag("做完了验收") == ("process", "做完了验收")
    assert parse_note_tag("[preference] 不要用 mini")[0] == "preference"
    assert parse_note_tag("[project] 旧标签")[0] == "process"


def test_preference_writes_standing(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(assets_paths, "assets_root", lambda: tmp_path)
    ent = EntityRef("employee", "demo-role")
    out = write_ad_hoc_note(ent, "[preference] 永远禁用 mini 档")
    assert out.get("kind") == "standing"
    assert str(out.get("path") or "").endswith("memory/standing.md")
    body = (tmp_path / "employees" / "demo-role" / "memory" / "standing.md").read_text(
        encoding="utf-8"
    )
    assert "永远禁用 mini" in body
    assert "User preferences" in body
    inbox = tmp_path / "employees" / "demo-role" / "memory" / "_inbox" / "notes"
    assert not inbox.exists() or not any(inbox.glob("*.md"))


def test_process_writes_episodic(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(assets_paths, "assets_root", lambda: tmp_path)
    ent = EntityRef("employee", "demo-role")
    out = write_ad_hoc_note(ent, "[process] 本轮完成样片验收")
    assert out.get("kind") == "episodic"
    assert "memory/episodic/" in str(out.get("path") or "")
    epi = tmp_path / "employees" / "demo-role" / "memory" / "episodic"
    assert any(epi.glob("*.md"))


def test_experience_writes_craft(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(assets_paths, "assets_root", lambda: tmp_path)
    ent = EntityRef("employee", "demo-role")
    out = write_ad_hoc_note(ent, "[experience] ffmpeg 帧率对齐\n\n细节…")
    assert out.get("kind") == "craft"
    assert str(out.get("path") or "").startswith("craft/")
