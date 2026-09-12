"""Tier-0 catalog must not list archival / task-closure facts every turn."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.assets.catalog import fact_tier0_catalog_eligible, format_entity_catalog_xml, list_fact_catalog
from evoflow.assets.hub import ensure_entity_tree, record_fact
from evoflow.assets.paths import EntityRef
from evoflow.config.paths import reset_paths_cache


@pytest.fixture
def assets_home(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_paths_cache()
        yield Path(tmp)
        reset_paths_cache()


def test_fact_tier0_skips_archival_and_goal_complete() -> None:
    assert not fact_tier0_catalog_eligible(
        meta={"access_tier": "archival"},
        title="任意标题",
    )
    assert not fact_tier0_catalog_eligible(
        meta={"evidence": '{"source": "goal_complete"}'},
        title="Goal「唱首歌」已完成",
    )
    assert fact_tier0_catalog_eligible(
        meta={"access_tier": "core"},
        title="用户偏好结论先行",
    )
    assert fact_tier0_catalog_eligible(
        meta={},
        title="默认使用 pnpm",
    )


def test_list_fact_catalog_omits_closure_files(assets_home: Path) -> None:
    ref = EntityRef("user", "user").normalized()
    ensure_entity_tree(ref)
    facts = assets_home / "assets" / "user" / "memory" / "facts"
    (facts / "pref.md").write_text(
        "---\ntitle: 偏好\naccess_tier: core\n---\n\n先结论\n",
        encoding="utf-8",
    )
    (facts / "goal-done.md").write_text(
        "---\naccess_tier: archival\nevidence: {\"source\": \"goal_complete\"}\n---\n\n"
        "# Goal「测试」已完成\n",
        encoding="utf-8",
    )

    titles = [r["title"] for r in list_fact_catalog(ref)]
    assert titles == ["偏好"]
    block = format_entity_catalog_xml(ref, include_standing=False, include_episodes=False, include_craft=False)
    assert "goal-done.md" not in block
    assert "pref.md" in block


def test_record_fact_still_appears_in_catalog(assets_home: Path) -> None:
    ref = EntityRef("user", "user").normalized()
    ensure_entity_tree(ref)
    record_fact(ref, "先诊断再改代码", title="调试习惯", summary="先诊断")
    titles = [r["title"] for r in list_fact_catalog(ref)]
    assert "调试习惯" in titles
