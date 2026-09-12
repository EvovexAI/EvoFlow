"""Duty wrap-up → employee Asset Hub journal/craft mirror."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.assets.paths import entity_root
from evoflow.config.paths import reset_paths_cache
from evoflow.person_wrap_up_reflect import mirror_wrap_up_to_asset_hub


@pytest.fixture
def assets_home(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_paths_cache()
        yield Path(tmp)
        reset_paths_cache()


def test_mirror_wrap_up_writes_journal_and_craft(assets_home: Path) -> None:
    del assets_home
    code = "demo-employee"
    out = mirror_wrap_up_to_asset_hub(
        code,
        {
            "journal": "我完成了巡检并核对了部署清单。",
            "mood": "steady",
            "arc_label": "calm",
            "state_summary": "仓库干净；下次先看 CI。",
            "craft": {
                "title": "部署前核对清单",
                "kind": "howto",
                "content": "1. 看 CI\n2. 核对 env\n3. 再合入",
            },
            "unresolved": ["跟进告警阈值"],
        },
        round_id="2026-08-28T10:00:00Z",
    )
    assert out.get("ok") is True
    assert out.get("journal")
    assert out.get("craft")

    from evoflow.assets.paths import EntityRef

    root = entity_root(EntityRef("employee", code))
    journals = list((root / "memory" / "journal").glob("*.md"))
    assert journals, "expected memory/journal/*.md"
    text = journals[0].read_text(encoding="utf-8")
    assert "巡检" in text
    assert "站立摘要" in text
    assert "2026-08-28T10:00:00Z" in text

    craft_skills = list((root / "craft").glob("*/SKILL.md"))
    assert craft_skills, "expected craft/*/SKILL.md"
    craft_text = craft_skills[0].read_text(encoding="utf-8")
    assert "核对" in craft_text or "CI" in craft_text


def test_mirror_wrap_up_skip_when_empty(assets_home: Path) -> None:
    del assets_home
    out = mirror_wrap_up_to_asset_hub("demo-employee", {"skip": True, "journal": ""})
    assert out.get("ok") is True
    assert out.get("skipped") is True
