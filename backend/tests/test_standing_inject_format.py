"""Standing inject shaping: prefs/tips keep; What's in Memory omitted (catalog owns)."""

from __future__ import annotations

from evoflow.assets.standing_format import format_standing_for_inject, normalize_standing_document


_DENSE = """v1

## User Profile
- role overview that can be long but secondary to prefs

## User preferences
- always call the user 爸爸
- conclusion first

## General Tips
- use --data-binary for Chinese curl bodies

## What's in Memory

### D:/dev/github/EvoFlow

#### 2026-11-04

- EvoFlow 生图网关: media.credentials, openai-image, b64_json
  - desc: long prose that must not stay in inject
  - learnings: retry once on do_request_failed
- craft/evopanel-page-redesign.md
  - desc: dense table rows
  - learnings: sync selectors
"""


def test_inject_keeps_prefs_drops_whats_in_memory() -> None:
    out = format_standing_for_inject(_DENSE)
    assert "## User preferences" in out
    assert "爸爸" in out
    assert "## General Tips" in out
    assert "## What's in Memory" not in out
    assert "craft/evopanel-page-redesign.md" not in out
    assert "desc:" not in out
    assert "learnings:" not in out


def test_inject_soft_caps_core_preferring_preferences() -> None:
    prefs = "\n".join(f"- pref bullet {i} " + ("x" * 40) for i in range(40))
    tips = "\n".join(f"- tip bullet {i} " + ("y" * 40) for i in range(40))
    profile = "\n".join(f"- profile {i} " + ("z" * 40) for i in range(40))
    raw = (
        "v1\n\n## User Profile\n"
        + profile
        + "\n\n## User preferences\n"
        + prefs
        + "\n\n## General Tips\n"
        + tips
        + "\n\n## What's in Memory\n\n- craft/a.md\n"
    )
    out = format_standing_for_inject(raw, core_max_chars=800)
    assert "## User preferences" in out
    assert "pref bullet 0" in out
    assert "## What's in Memory" not in out
    assert len(out) < len(raw)


def test_normalize_standing_document_still_collapses_disk_index() -> None:
    out = normalize_standing_document(_DENSE)
    assert out.startswith("v1\n")
    assert "## What's in Memory" in out
    assert "desc:" not in out
    assert "craft/evopanel-page-redesign.md" in out


def test_inject_index_only_standing_becomes_empty() -> None:
    out = format_standing_for_inject(
        "v1\n\n## What's in Memory\n\n- craft/a.md\n- craft/b.md\n"
    )
    assert out == ""
