"""Unified hormone affect substrate (all agents)."""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

import pytest

from evoflow.config.paths import reset_paths_cache
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.timeutil import BEIJING_TZ


@pytest.fixture()
def db_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    reset_paths_cache()
    reset_db_for_tests()
    get_db()
    yield tmp_path
    reset_db_for_tests()
    reset_paths_cache()


def test_default_insert_and_prose_has_no_floats(db_home: Path):
    from evoflow.persistence import person_relations_repositories as rel
    from evoflow.person_affect import format_affect_prose
    from evoflow.person_kernel import format_affect_brief

    aff = rel.ensure_affect_row("xiaomi")
    assert aff["oxytocin"] == pytest.approx(0.55, abs=0.02)
    assert aff["cortisol"] == pytest.approx(0.25, abs=0.02)
    # Dual-write legacy
    assert "connection" in aff and "curiosity" in aff

    prose = format_affect_prose(aff)
    brief = format_affect_brief("xiaomi")
    for text in (prose, brief):
        assert "oxytocin" not in text.lower()
        assert "0.55" not in text
        assert "此刻心境" in text


def test_legacy_delta_maps_to_hormones(db_home: Path):
    from evoflow.persistence import person_relations_repositories as rel

    rel.ensure_affect_row("ops-bot")
    before = rel.get_affect("ops-bot", apply_decay=False)
    out = rel.apply_affect_deltas(
        "ops-bot",
        {"curiosity": 0.1, "pressure": 0.08},
        significant=True,
        source="test",
    )
    assert out.get("ok") is True
    after = rel.get_affect("ops-bot", apply_decay=False)
    assert after["dopamine"] > before["dopamine"]
    assert after["cortisol"] > before["cortisol"]
    meta = after.get("meta") or {}
    assert meta.get("last_significant_at")


def test_decay_toward_setpoint(db_home: Path):
    from evoflow.person_affect import decay_hormones_toward_setpoint

    high = {
        "oxytocin": 0.9,
        "dopamine": 0.9,
        "serotonin": 0.9,
        "cortisol": 0.9,
        "energy": 0.9,
    }
    past = (datetime.now(BEIJING_TZ) - timedelta(hours=24)).isoformat()
    decayed = decay_hormones_toward_setpoint(high, updated_at=past)
    # After a day, dopamine (2h half-life) should be near setpoint 0.50
    assert decayed["dopamine"] < 0.7
    assert decayed["dopamine"] > 0.45


def test_hormones_from_legacy_mapping():
    from evoflow.person_affect import hormones_from_legacy

    h = hormones_from_legacy(
        {
            "connection": 0.8,
            "curiosity": 0.7,
            "confidence": 0.6,
            "pressure": 0.4,
            "frustration": 0.2,
            "energy": 0.5,
        }
    )
    assert h["oxytocin"] == pytest.approx(0.8)
    assert h["dopamine"] == pytest.approx(0.7)
    assert h["energy"] == pytest.approx(0.5)
    assert h["cortisol"] >= 0.4


def test_parse_affect_tag_and_strip():
    from evoflow.person_affect import parse_affect_tag, strip_affect_tags

    text = "嗯我在。\n[AFFECT: oxytocin=+0.08, cortisol=-0.05]"
    deltas = parse_affect_tag(text)
    assert deltas is not None
    assert deltas["oxytocin"] == pytest.approx(0.08)
    assert deltas["cortisol"] == pytest.approx(-0.05)
    cleaned = strip_affect_tags(text)
    assert "AFFECT" not in cleaned
    assert "嗯我在" in cleaned


def test_affect_md_ensured_for_employee(db_home: Path, monkeypatch: pytest.MonkeyPatch):
    from evoflow.assets.hub import ensure_entity_tree
    from evoflow.assets.paths import EntityRef, profile_path

    monkeypatch.setattr(
        "evoflow.assets.guidance.is_employee_agent_name",
        lambda name: str(name or "").lower() == "douyin-analyst",
    )
    ent = EntityRef("employee", "douyin-analyst").normalized()
    ensure_entity_tree(ent)
    path = profile_path(ent, "affect.md")
    assert path.is_file()
    body = path.read_text(encoding="utf-8")
    assert "情感" in body
    assert "主人" not in body


def test_format_affect_block_title(db_home: Path):
    from evoflow.person_kernel import format_affect_and_commitments_block

    from evoflow.persistence import person_relations_repositories as rel

    rel.ensure_affect_row("ops-bot")
    block = format_affect_and_commitments_block("ops-bot")
    assert "此刻心境" in block
    assert "职场情绪态" not in block
    assert "0.55" not in block
