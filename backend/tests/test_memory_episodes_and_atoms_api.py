"""Episode + atoms API smoke tests."""

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
    from evoflow.knowledge.owned.db import reset_db_state_for_tests

    reset_db_state_for_tests()
    reset_storage_for_tests()
    yield root
    reset_db_state_for_tests()
    reset_storage_for_tests()


def test_record_task_episode(owned_memory_root: Path):
    from evoflow.memory.document_codec import namespace_for_agent_key
    from evoflow.memory.episodes import record_task_episode
    from evoflow.memory.facade import recall

    aid = record_task_episode(
        {
            "id": "T-demo-1",
            "title": "支付 API 重构",
            "goal": "拆分 webhook 校验",
            "result": "已合并 PR，校验独立中间件",
        },
        agent_name="main",
        outcome="completed",
    )
    assert aid
    hits = recall([namespace_for_agent_key("main")], "webhook 校验", top_k=5)
    assert any("支付" in (h.get("content") or "") for h in hits)


def test_atoms_api_list_create(owned_memory_root: Path):
    """Atoms CRUD/recall via facade (same path Gateway routers call)."""
    from evoflow.memory.document_codec import namespace_for_agent_key
    from evoflow.memory.facade import forget, list_atoms, pin_atom, recall, remember

    ns = namespace_for_agent_key("main")
    aid = remember(
        ns,
        "用户偏好暗色主题",
        layer="semantic",
        kind="preference",
        pin=True,
        confidence=0.9,
        source="manual",
    )
    assert aid
    rows = list_atoms(ns, limit=100)
    assert any(r.get("id") == aid for r in rows)
    assert pin_atom(aid, False)
    hits = recall([ns], "主题偏好", top_k=5)
    assert isinstance(hits, list)
    assert forget(aid)
