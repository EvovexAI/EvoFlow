"""Tests for Asset Hub startup Phase2 scan and usage stats aggregate."""

from __future__ import annotations

import gc
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from evoflow.assets.hub import ensure_entity_tree, write_text_file
from evoflow.assets.paths import EntityRef
from evoflow.assets.startup import asset_startup_phase2_enabled, scan_and_run_phase2_on_startup
from evoflow.assets.usage import collect_entity_usage_stats, touch_asset_usage
from evoflow.config.paths import reset_paths_cache
from evoflow.persistence.db import reset_db_for_tests


@pytest.fixture
def assets_home(monkeypatch: pytest.MonkeyPatch):
    # ignore_cleanup_errors: Windows WAL keeps evoflow.db locked briefly after list_entities().
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_paths_cache()
        reset_db_for_tests()
        yield Path(tmp)
        reset_db_for_tests()
        reset_paths_cache()
        gc.collect()


@pytest.fixture
def entity(assets_home: Path) -> EntityRef:
    ref = EntityRef("user", "user").normalized()
    ensure_entity_tree(ref)
    return ref


def test_startup_phase2_disabled(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_ASSET_STARTUP_PHASE2", "0")
    assert asset_startup_phase2_enabled() is False
    out = scan_and_run_phase2_on_startup()
    assert out.get("skipped") == "disabled"


def test_collect_entity_usage_stats(entity: EntityRef):
    write_text_file(
        entity,
        "memory/facts/hot.md",
        "---\ntitle: 偏好\nsummary: 先诊断\nuse_count: 3\nlast_used_at: 2026-08-25T10:00:00Z\n---\n\nbody\n",
    )
    write_text_file(
        entity,
        "memory/_inbox/raw_t1.md",
        "---\nsource: phase1\n---\n\npending draft\n",
    )
    touch_asset_usage(entity, "memory/facts/hot.md")
    stats = collect_entity_usage_stats(entity, top_n=5)
    assert stats.get("ok") is True
    assert stats["totals"]["inboxPending"] >= 1
    assert stats["totals"]["memoryFiles"] >= 1
    hot = stats.get("hot") or []
    assert any(h.get("path", "").endswith("hot.md") for h in hot)


def test_startup_scan_runs_phase2_for_pending_inbox(
    entity: EntityRef, assets_home: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("EVOFLOW_ASSET_STARTUP_PHASE2", "1")
    monkeypatch.setenv("EVOFLOW_ASSET_PHASE2", "1")

    write_text_file(
        entity,
        "memory/_inbox/raw_boot.md",
        "---\nsource: phase1\n---\n\nPreference signals:\n- diagnose first\n\nReusable knowledge:\n- rebase\n",
    )

    payload = {
        "noop": False,
        "standing_md": "v1\n\n## User preferences\n\n- diagnose first\n",
        "memory_md": "# Task Group: workflow\nscope: test\napplies_to: cwd=.; reuse_rule=general\n\n## Reusable knowledge\n\n- rebase\n",
        "craft": [],
        "facts": [],
    }
    mock_model = MagicMock()
    mock_model.invoke.return_value = SimpleNamespace(content=json.dumps(payload))

    class _Cfg:
        enabled = True
        model_name = None

    monkeypatch.setattr(
        "evoflow.config.memory_config.get_memory_config",
        lambda: _Cfg(),
    )
    monkeypatch.setattr(
        "evoflow.models.create_chat_model",
        lambda **kwargs: mock_model,
    )

    out = scan_and_run_phase2_on_startup(max_entities=8)
    assert out.get("ok") is True, out
    assert out.get("ran", 0) >= 1
