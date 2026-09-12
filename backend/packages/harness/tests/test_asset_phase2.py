"""Tests for Asset Hub Phase2 consolidation."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from evoflow.assets.hub import ensure_entity_tree, write_text_file
from evoflow.assets.paths import EntityRef
from evoflow.assets.phase2 import (
    asset_phase2_enabled,
    list_inbox_pending,
    rebuild_raw_memories_file,
    run_phase2_consolidate,
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


def test_phase2_enabled_default(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("EVOFLOW_ASSET_PHASE2", raising=False)
    assert asset_phase2_enabled() is True
    monkeypatch.setenv("EVOFLOW_ASSET_PHASE2", "0")
    assert asset_phase2_enabled() is False


def test_rebuild_raw_memories_merges_pending(entity: EntityRef):
    write_text_file(
        entity,
        "memory/_inbox/raw_t1.md",
        "---\nsource: phase1\n---\n\n## Learning\n\n- use rebase\n",
    )
    write_text_file(
        entity,
        "memory/_inbox/notes/pref.md",
        "记住：先诊断再改 [ad-hoc note]\n",
    )
    merged, rels = rebuild_raw_memories_file(entity)
    assert "rebase" in merged
    assert "先诊断" in merged
    assert any("raw_t1.md" in r for r in rels)
    assert any("notes/pref.md" in r for r in rels)
    pending = list_inbox_pending(entity)
    assert len(pending) == 2


def test_run_phase2_skips_empty_inbox(entity: EntityRef, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_ASSET_PHASE2", "1")

    class _Cfg:
        enabled = True
        model_name = None

    monkeypatch.setattr(
        "evoflow.config.memory_config.get_memory_config",
        lambda: _Cfg(),
    )
    out = run_phase2_consolidate(entity=entity)
    assert out.get("skipped") == "inbox_empty"


def test_run_phase2_writes_and_archives(entity: EntityRef, assets_home: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_ASSET_PHASE2", "1")

    class _Cfg:
        enabled = True
        model_name = None

    monkeypatch.setattr(
        "evoflow.config.memory_config.get_memory_config",
        lambda: _Cfg(),
    )

    write_text_file(
        entity,
        "memory/_inbox/raw_ci.md",
        "---\nsource: phase1\n---\n\nPreference signals:\n- when tests fail, diagnose first\n\nReusable knowledge:\n- rebase before push\n",
    )

    payload = {
        "noop": False,
        "standing_md": "v1\n\n## User preferences\n\n- 测试失败先诊断\n\n## What's in Memory\n\n- ci / rebase\n",
        "memory_md": (
            "# Task Group: ci\n"
            "scope: CI 与分支工作流\n"
            "applies_to: cwd=project; reuse_rule=general\n\n"
            "## Task 1: 修好缓存\n\n"
            "### keywords\n\n- cargo, cache, rebase\n\n"
            "## User preferences\n\n- when 测试失败, diagnose first\n\n"
            "## Reusable knowledge\n\n- rebase before push\n"
        ),
        "craft": [
            {
                "slug": "rebase-before-push",
                "title": "共享分支先 rebase",
                "skill_md": "# 共享分支先 rebase\n\n1. fetch\n2. rebase\n3. push\n",
            }
        ],
        "facts": [
            {
                "filename": "diagnose-first.md",
                "content": "---\ntitle: 先诊断\nsummary: 测试失败先看日志\n---\n\ndiagnose before edit\n",
            }
        ],
    }
    mock_model = MagicMock()
    mock_model.invoke.return_value = SimpleNamespace(content=json.dumps(payload))
    monkeypatch.setattr(
        "evoflow.models.create_chat_model",
        lambda **kwargs: mock_model,
    )

    out = run_phase2_consolidate(entity=entity)
    assert out.get("ok") is True, out
    assert not out.get("skipped"), out
    paths = out.get("paths") or []
    assert "memory/standing.md" in paths
    assert "memory/MEMORY.md" in paths
    assert any(p.startswith("craft/") for p in paths)
    assert any("facts/" in p for p in paths)

    standing = (assets_home / "assets" / "user" / "memory" / "standing.md").read_text(encoding="utf-8")
    assert standing.splitlines()[0].strip() == "v1"
    assert "诊断" in standing

    memory = (assets_home / "assets" / "user" / "memory" / "MEMORY.md").read_text(encoding="utf-8")
    assert "Task Group: ci" in memory

    craft = assets_home / "assets" / "user" / "craft" / "rebase-before-push" / "SKILL.md"
    assert craft.is_file()

    # Inbox archived — no longer pending
    assert list_inbox_pending(entity) == []
    done = assets_home / "assets" / "user" / "memory" / "_inbox" / "_done"
    assert any(done.glob("*-raw_ci.md"))


def test_run_phase2_noop_still_archives(entity: EntityRef, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_ASSET_PHASE2", "1")

    class _Cfg:
        enabled = True
        model_name = None

    monkeypatch.setattr(
        "evoflow.config.memory_config.get_memory_config",
        lambda: _Cfg(),
    )
    write_text_file(entity, "memory/_inbox/raw_hi.md", "just a hello with no reusable learning\n")
    mock_model = MagicMock()
    mock_model.invoke.return_value = SimpleNamespace(
        content='{"noop":true,"standing_md":"","memory_md":"","craft":[],"facts":[]}'
    )
    monkeypatch.setattr(
        "evoflow.models.create_chat_model",
        lambda **kwargs: mock_model,
    )
    out = run_phase2_consolidate(entity=entity)
    assert out.get("ok") is True
    assert out.get("skipped") == "no_signal"
    assert list_inbox_pending(entity) == []
