"""Workspace Asset Hub memory (catalog form)."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.agents.memory.workspace_memory import (
    create_empty_workspace_memory,
    format_workspace_memory_context,
    get_workspace_memory_data,
    prune_workspace_memory,
    seed_workspace_memory,
    workspace_scope_id,
)
from evoflow.assets.catalog import catalog_has_content, list_fact_catalog
from evoflow.assets.hub import ensure_entity_tree, record_fact
from evoflow.assets.paths import workspace_entity_ref
from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        get_db()
        yield Path(tmp)
        reset_db_for_tests()
        import gc

        gc.collect()


def test_workspace_scope_id_matches_agent_pattern() -> None:
    scope = workspace_scope_id("/tmp/my-project")
    assert scope.startswith("ws-")
    assert len(scope) == 35  # ws- + 32 hex


def test_create_empty_workspace_memory_is_catalog(sqlite_tmp: Path) -> None:
    root = sqlite_tmp / "repo"
    root.mkdir()
    mem = create_empty_workspace_memory(str(root))
    assert mem["format"] == "asset_catalog"
    assert mem["entityType"] == "workspace"
    assert mem["entityId"].startswith("ws-")
    assert "facts" in mem
    assert "craft" in mem
    assert "project" not in mem


def test_record_fact_and_catalog_inject_legacy_mode(sqlite_tmp: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.config.memory_config import MemoryConfig, set_memory_config

    set_memory_config(MemoryConfig(injection_mode="legacy"))
    monkeypatch.setenv("EVOFLOW_HOME", str(sqlite_tmp))
    from evoflow.config import memory_config as mc

    class _Cfg:
        enabled = True
        injection_enabled = True
        injection_mode = "legacy"
        model_name = None
        max_injection_tokens = 2000
        chat_compact_max_tokens = 800
        fact_confidence_threshold = 0.5
        max_facts = 100

    monkeypatch.setattr(mc, "get_memory_config", lambda: _Cfg())

    root = sqlite_tmp / "proj"
    root.mkdir()
    ref = workspace_entity_ref(str(root))
    ensure_entity_tree(ref)
    record_fact(ref, "默认使用 pnpm 安装依赖", title="包管理", summary="默认用 pnpm")

    assert catalog_has_content(ref)
    facts = list_fact_catalog(ref)
    assert facts
    assert facts[0]["title"] == "包管理"
    assert len(facts[0]["summary"]) <= 30

    block = format_workspace_memory_context(str(root))
    assert "<workspace_memory>" in block
    assert "<catalog>" in block
    assert "f memory/facts/" in block or "包管理" in block
    # Must not dump legacy project sections
    assert "Overview" not in block
    assert "Architecture" not in block


def test_get_workspace_memory_data_lists_files(sqlite_tmp: Path) -> None:
    root = sqlite_tmp / "app"
    root.mkdir()
    ref = workspace_entity_ref(str(root))
    ensure_entity_tree(ref)
    record_fact(ref, "入口在 backend/app", title="入口", summary="FastAPI 入口")
    data = get_workspace_memory_data(str(root))
    assert data["format"] == "asset_catalog"
    assert any(f.get("title") == "入口" for f in data["facts"])


def test_prune_workspace_memory_drops_ephemeral(sqlite_tmp: Path) -> None:
    root = sqlite_tmp / "proj"
    root.mkdir()
    ref = workspace_entity_ref(str(root))
    ensure_entity_tree(ref)
    record_fact(ref, "Default package manager is pnpm for this repo.", title="Package manager", summary="Use pnpm")
    record_fact(ref, "hello world test", title="Temp test", summary="test")
    out = prune_workspace_memory(str(root))
    assert out["deleted"]["facts"]
    assert out["kept"]["facts"] == 1
    data = get_workspace_memory_data(str(root))
    assert len(data["facts"]) == 1
    assert data["facts"][0]["title"] == "Package manager"


def test_seed_workspace_memory_evoflow_layout(sqlite_tmp: Path) -> None:
    root = sqlite_tmp / "EvoFlow"
    (root / "backend" / "packages" / "harness" / "evoflow").mkdir(parents=True)
    (root / "evopanel").mkdir()
    out = seed_workspace_memory(str(root))
    assert out["status"] == "ok"
    data = get_workspace_memory_data(str(root))
    assert data["facts"]
    assert any("harness" in str(f.get("title") or "").lower() for f in data["facts"])
    standing = str(data.get("standing") or "")
    assert "EvoFlow" in standing or "Agent" in standing
