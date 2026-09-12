"""Minimal memory stale-on-close hygiene."""

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


def test_mark_atom_stale_tags_and_lowers_vitality(owned_memory_root: Path) -> None:
    from evoflow.memory.facade import mark_atom_stale, remember
    from evoflow.memory.namespaces import user_ns
    from evoflow.memory import store as mem_store

    ns = user_ns("default")
    aid = remember(
        ns,
        "登录页闪烁是 CSS 动画导致的，需要关掉 transition",
        layer="episodic",
        kind="episode",
        confidence=0.9,
        importance=0.8,
        source="manual",
    )
    assert aid
    assert mark_atom_stale(aid, reason="task completed", source_ref="task:t1")
    atom = mem_store.get_atom(aid)
    assert atom
    assert "stale" in {str(t).lower() for t in (atom.get("tags") or [])}
    assert float(atom.get("vitality") or 1.0) <= 0.2
    assert (atom.get("evidence") or {}).get("stale_source_ref") == "task:t1"


def test_mark_related_skips_pinned(owned_memory_root: Path) -> None:
    from evoflow.memory.facade import mark_related_memories_stale, remember
    from evoflow.memory.namespaces import user_ns
    from evoflow.memory import store as mem_store

    ns = user_ns("default")
    pinned = remember(
        ns,
        "登录页闪烁根因已确认是 CSS transition，长期保留",
        layer="semantic",
        kind="fact",
        confidence=0.95,
        importance=0.95,
        pin=True,
        source="manual",
    )
    loose = remember(
        ns,
        "登录页闪烁可能是 websocket 重连导致，待验证",
        layer="episodic",
        kind="episode",
        confidence=0.7,
        importance=0.6,
        source="manual",
    )
    out = mark_related_memories_stale(
        query="登录页闪烁",
        namespaces=[ns],
        reason="item marked done",
        source_ref="item:i1",
    )
    assert out.get("ok") is True
    assert out.get("marked") == 1
    assert loose in (out.get("atom_ids") or [])
    assert "stale" in {str(t).lower() for t in (mem_store.get_atom(loose) or {}).get("tags") or []}
    assert "stale" not in {
        str(t).lower() for t in (mem_store.get_atom(pinned) or {}).get("tags") or []
    }


def test_stale_memories_on_close_helper(owned_memory_root: Path) -> None:
    from evoflow.memory.facade import remember
    from evoflow.memory.namespaces import user_ns
    from evoflow.memory.stale_on_close import stale_memories_on_close
    from evoflow.memory import store as mem_store

    ns = user_ns("default")
    aid = remember(
        ns,
        "首页 Banner 错位需要调整 padding",
        layer="episodic",
        kind="episode",
        confidence=0.8,
        importance=0.7,
        source="manual",
    )
    out = stale_memories_on_close(
        title="首页 Banner 错位",
        notes="已修好",
        source_ref="item:banner",
        reason="item marked done",
    )
    assert out.get("ok") is True
    assert out.get("marked") >= 1
    assert "stale" in {str(t).lower() for t in (mem_store.get_atom(aid) or {}).get("tags") or []}
