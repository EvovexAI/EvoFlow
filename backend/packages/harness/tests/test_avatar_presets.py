"""Tests for system avatar presets."""

from __future__ import annotations

from evoflow.config import avatar_presets as ap


def test_list_presets_includes_pm_and_engineer():
    rows = ap.list_presets()
    ids = {r["id"] for r in rows}
    assert "pm" in ids
    assert "engineer" in ids
    assert len(rows) >= 12


def test_parse_preset_avatar_known():
    assert ap.parse_preset_avatar("preset:pm") == "pm"
    assert ap.parse_preset_avatar("preset:engineer") == "engineer"


def test_parse_preset_avatar_legacy_ignored():
    assert ap.parse_preset_avatar("preset:mochi") is None
    assert ap.parse_preset_avatar("preset:ink") is None
    assert ap.parse_preset_avatar("preset:bolt") is None


def test_parse_preset_avatar_unknown():
    assert ap.parse_preset_avatar("preset:does-not-exist-xyz") is None
    assert ap.parse_preset_avatar("emoji:✨") is None
    assert ap.parse_preset_avatar("image") is None


def test_preset_path_exists():
    path = ap.preset_path("pm")
    assert path is not None
    assert path.is_file()


def test_pick_random_preset_avatar():
    ids = {r["id"] for r in ap.list_presets()}
    seen: set[str] = set()
    for _ in range(40):
        avatar = ap.pick_random_preset_avatar()
        assert avatar is not None
        assert avatar.startswith("preset:")
        pid = avatar.split(":", 1)[1]
        assert pid in ids
        seen.add(pid)
        assert ap.preset_path(pid) is not None
    # With 12 presets, 40 draws should almost always hit >1 distinct ids.
    assert len(seen) >= 2
