"""Tests for asset usage, citation parse, and compaction↔asset complementarity."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.agents.context_compaction_core import MAIN_SUMMARY_PREFIX
from evoflow.assets.citation import extract_evo_asset_citations, record_citations_from_messages
from evoflow.assets.hub import ensure_entity_tree, write_text_file
from evoflow.assets.paths import EntityRef
from evoflow.assets.usage import (
    asset_is_stale,
    max_unused_days,
    prune_done_inbox,
    touch_asset_citation,
    touch_asset_usage,
)
from evoflow.config.paths import reset_paths_cache


@pytest.fixture
def assets_home(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_paths_cache()
        yield Path(tmp)
        reset_paths_cache()


@pytest.fixture
def entity(assets_home: Path) -> EntityRef:
    ref = EntityRef("user", "user").normalized()
    ensure_entity_tree(ref)
    return ref


def test_compaction_prefix_mentions_asset_hub():
    assert "Asset Hub" in MAIN_SUMMARY_PREFIX
    assert "assets(action=search|read)" in MAIN_SUMMARY_PREFIX


def test_extract_evo_asset_citations():
    raw = (
        "修好了缓存。\n\n"
        "<evo-asset-citation>\n"
        "<citation_entries>\n"
        "memory/MEMORY.md:12-18|note=[先诊断再改]\n"
        "memory/episodic/2026-08-25-ci.md:1-40|note=[CI 证据]\n"
        "</citation_entries>\n"
        "</evo-asset-citation>\n"
    )
    out = extract_evo_asset_citations(raw)
    assert "修好了缓存" in out["text"]
    assert "<evo-asset-citation>" not in out["text"]
    assert len(out["entries"]) == 2
    assert out["entries"][0]["path"] == "memory/MEMORY.md"
    assert out["entries"][0]["note"] == "先诊断再改"
    assert out["entries"][0]["lineStart"] == 12


def test_touch_asset_citation(entity: EntityRef):
    write_text_file(
        entity,
        "memory/facts/cited.md",
        "---\ntitle: cited\nsummary: x\n---\n\nbody\n",
    )
    assert touch_asset_citation(entity, "memory/facts/cited.md") is True
    from evoflow.assets.hub import read_text_file

    text = read_text_file(entity, "memory/facts/cited.md")["content"]
    assert "last_cited_at:" in text
    assert "cite_count: 1" in text
    assert "use_count:" not in text


def test_record_citations_from_messages(entity: EntityRef):
    class _Msg:
        def __init__(self, role: str, content: str, tool_calls=None):
            self.type = role
            self.content = content
            self.tool_calls = tool_calls

    messages = [
        _Msg("human", "help"),
        _Msg(
            "ai",
            "done.\n\n<evo-asset-citation>\n<citation_entries>\n"
            "memory/facts/cited.md:1-5|note=[ref]\n"
            "</citation_entries>\n</evo-asset-citation>\n",
        ),
    ]
    write_text_file(entity, "memory/facts/cited.md", "---\ntitle: cited\n---\n\nbody\n")
    out = record_citations_from_messages(messages, entity=entity)
    assert out.get("ok") is True
    assert out.get("recorded") == 1
    from evoflow.assets.hub import read_text_file

    text = read_text_file(entity, "memory/facts/cited.md")["content"]
    assert "cite_count: 1" in text


def test_touch_and_stale(entity: EntityRef, monkeypatch: pytest.MonkeyPatch):
    write_text_file(
        entity,
        "memory/facts/pref.md",
        "---\ntitle: 偏好\nsummary: 先诊断\n---\n\nbody\n",
    )
    assert touch_asset_usage(entity, "memory/facts/pref.md") is True
    from evoflow.assets.hub import read_text_file

    text = read_text_file(entity, "memory/facts/pref.md")["content"]
    assert "last_used_at:" in text
    assert "use_count: 1" in text
    assert asset_is_stale(entity, "memory/facts/pref.md", max_days=90) is False

    monkeypatch.setenv("EVOFLOW_ASSET_MAX_UNUSED_DAYS", "1")
    assert max_unused_days() == 1
    # Force ancient stamp
    write_text_file(
        entity,
        "memory/facts/old.md",
        "---\ntitle: old\nsummary: x\nlast_used_at: 2020-01-01T00:00:00Z\nuse_count: 1\n---\n\nold\n",
    )
    assert asset_is_stale(entity, "memory/facts/old.md") is True


def test_prune_done_inbox(entity: EntityRef, assets_home: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_ASSET_MAX_UNUSED_DAYS", "1")
    done = assets_home / "assets" / "user" / "memory" / "_inbox" / "_done"
    done.mkdir(parents=True, exist_ok=True)
    stale = done / "old-raw.md"
    stale.write_text("x", encoding="utf-8")
    import os
    import time

    old = time.time() - 3 * 86400
    os.utime(stale, (old, old))
    fresh = done / "fresh.md"
    fresh.write_text("y", encoding="utf-8")
    out = prune_done_inbox(entity, max_days=1)
    assert out["deleted"] >= 1
    assert not stale.exists()
    assert fresh.exists()
