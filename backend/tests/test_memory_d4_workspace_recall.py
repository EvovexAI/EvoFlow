"""Tests for workspace project memory + recall snapshot (D4/U2)."""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture()
def owned_memory_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "knowledge"
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("EVOFLOW_KNOWLEDGE_ROOT", str(root))
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    from evoflow.agents.memory.storage import reset_storage_for_tests
    from evoflow.config.memory_config import MemoryConfig, set_memory_config
    from evoflow.knowledge.owned.db import reset_db_state_for_tests
    from evoflow.memory.recall_snapshot import reset_for_tests

    reset_db_state_for_tests()
    reset_storage_for_tests()
    reset_for_tests()
    set_memory_config(MemoryConfig())
    yield root
    reset_for_tests()
    set_memory_config(MemoryConfig())
    reset_db_state_for_tests()
    reset_storage_for_tests()


def test_workspace_project_memory_isolated(owned_memory_root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("evoflow.memory.facade._maybe_enqueue_threshold", lambda *_a, **_k: None)

    from evoflow.memory.facade import list_atoms
    from evoflow.memory.namespaces import agent_ns
    from evoflow.memory.workspace_ui import list_workspace_atoms, remember_workspace_atom

    ws_a = tmp_path / "proj-a"
    ws_b = tmp_path / "proj-b"
    ws_a.mkdir()
    ws_b.mkdir()

    remember_workspace_atom(str(ws_a), "仓库 A 默认用 pnpm", kind="convention", pin=True)
    remember_workspace_atom(str(ws_b), "仓库 B 默认用 npm", kind="convention", pin=True)

    a = list_workspace_atoms(str(ws_a))
    b = list_workspace_atoms(str(ws_b))
    assert a["namespace"] != b["namespace"]
    assert any("pnpm" in (x.get("content") or "") for x in a["atoms"])
    assert not any("pnpm" in (x.get("content") or "") for x in b["atoms"])
    # Does not pollute agent:main
    assert not any("pnpm" in (x.get("content") or "") for x in list_atoms(agent_ns("main"), limit=50))


def test_recall_snapshot_records_hits(owned_memory_root: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("evoflow.memory.facade._maybe_enqueue_threshold", lambda *_a, **_k: None)

    from evoflow.agents.lead_agent.prompt import build_memory_query_recall_sections
    from evoflow.memory.document_codec import namespace_for_agent_key
    from evoflow.memory.facade import remember
    from evoflow.memory.recall_snapshot import get_thread_recall

    # Dialogue archival is user-scoped (namespace_for_agent_key → user:default)
    ns = namespace_for_agent_key("main")
    remember(ns, "支付 API 重构结论是拆分 webhook", layer="episodic", confidence=0.9, source="manual")
    text = build_memory_query_recall_sections(
        agent_name="main",
        query="支付 API",
        thread_id="thread-d4-test",
        standing_preview="常驻：偏好 Python",
    )
    snap = get_thread_recall("thread-d4-test")
    assert snap is not None
    assert snap["hit_count"] >= 1
    assert "支付" in (text or "") or snap["hits"]
    assert "Python" in (snap.get("standing_preview") or "")
