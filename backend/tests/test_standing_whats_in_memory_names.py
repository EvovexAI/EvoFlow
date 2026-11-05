"""What's in Memory must collapse to name-only bullets."""

from evoflow.assets.phase2 import _normalize_standing


def test_normalize_standing_collapses_dense_whats_in_memory() -> None:
    raw = """v1

## User Profile
- demo

## User preferences
- keep prefs

## General Tips
- keep tips

## What's in Memory

### D:/dev/github

#### 2026-11-04

- EvoFlow 生图网关: media.credentials, openai-image, b64_json
  - desc: long prose that must not stay in standing
  - learnings: retry once on do_request_failed
- EvoPanel 自动化页 UI 重设计: cron.js, craft/evopanel-page-redesign.md
  - desc: dense table rows
  - learnings: sync .cron-row selectors

### Older Memory Topics

#### D:/dev/github/EvoFlow
- 员工名册卡: roleDeptLabel, craft/evoflow-role-card-enhancement.md
  - desc: chip layout
"""
    out = _normalize_standing(raw)
    assert out.startswith("v1\n")
    assert "## What's in Memory" in out
    assert "craft/evopanel-page-redesign.md" in out
    assert "craft/evoflow-role-card-enhancement.md" in out
    assert "EvoFlow 生图网关" in out
    assert "desc:" not in out
    assert "learnings:" not in out
    assert "#### 2026-11-04" not in out
    assert "media.credentials, openai-image" not in out


def test_normalize_standing_keeps_already_name_only() -> None:
    raw = """v1

## User Profile
- demo

## What's in Memory

### D:/dev/github

- craft/evopanel-page-redesign.md
- right-stage-session-memory
"""
    out = _normalize_standing(raw)
    assert "- craft/evopanel-page-redesign.md" in out
    assert "- right-stage-session-memory" in out
