"""Recall-quality fixes: standing filter, CJK keyword, weak archival gate."""

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


def test_get_core_excludes_knowledge_encyclopedia(owned_memory_root: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("evoflow.memory.facade._maybe_enqueue_threshold", lambda *_a, **_k: None)

    from evoflow.memory.facade import get_core, remember
    from evoflow.memory.namespaces import agent_ns

    ns = agent_ns("main")
    remember(
        ns,
        "下班后用 bullet 回复，称呼青柠",
        kind="preference",
        confidence=0.95,
        importance=0.9,
        source="manual",
    )
    remember(
        ns,
        "FastGPT 存架构：ContentOS 与 EvoFlow 记忆无关的百科长文",
        kind="knowledge",
        confidence=0.95,
        importance=0.95,
        pin=True,
        source="migrate",
    )
    core = get_core([ns], max_chars=2000)
    texts = " ".join(a.get("content") or "" for a in core)
    assert "青柠" in texts
    assert "FastGPT" not in texts


def test_standing_facts_skip_knowledge(owned_memory_root: Path):
    from evoflow.agents.memory.prompt import format_memory_for_injection

    doc = {
        "user": {
            "workContext": {"summary": "后端工程师"},
            "personalContext": {"summary": "偏好简洁"},
        },
        "facts": [
            {
                "content": "FastGPT 存架构细节很长很长",
                "category": "knowledge",
                "confidence": 0.95,
                "source": "migrate",
            },
            {
                "content": "称呼用户为青柠",
                "category": "preference",
                "confidence": 0.95,
                "source": "tool",
            },
        ],
    }
    text = format_memory_for_injection(doc, max_tokens=800, injection_profile="chat_compact")
    assert "青柠" in text
    assert "FastGPT" not in text


def test_chinese_keyword_recall_bigram(owned_memory_root: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("evoflow.memory.facade._maybe_enqueue_threshold", lambda *_a, **_k: None)

    from evoflow.memory.facade import recall, remember
    from evoflow.memory.namespaces import agent_ns

    ns = agent_ns("main")
    remember(
        ns,
        "用户下班后希望用 bullet 回复，称呼青柠",
        layer="semantic",
        kind="preference",
        confidence=0.92,
        source="tool",
    )
    hits = recall([ns], "青柠", layers=["semantic"], top_k=5, max_chars=800)
    assert hits
    assert any("青柠" in (h.get("content") or "") for h in hits)
    hits2 = recall([ns], "bullet", layers=["semantic"], top_k=5, max_chars=800)
    assert any("bullet" in (h.get("content") or "").lower() for h in hits2)


def test_weak_query_skips_archival(owned_memory_root: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("evoflow.memory.facade._maybe_enqueue_threshold", lambda *_a, **_k: None)

    from evoflow.agents.lead_agent.prompt import (
        _archival_query_worthwhile,
        build_memory_query_recall_sections,
    )
    from evoflow.memory.facade import remember
    from evoflow.memory.namespaces import agent_ns
    from evoflow.memory.recall_snapshot import get_thread_recall

    ns = agent_ns("main")
    remember(
        ns,
        "EvoFlow 记忆与 ContentOS 无关噪声",
        layer="semantic",
        kind="knowledge",
        confidence=0.9,
        source="migrate",
    )
    assert not _archival_query_worthwhile("今天做什么")
    assert not _archival_query_worthwhile("你好")
    assert _archival_query_worthwhile("青柠")

    text = build_memory_query_recall_sections(
        agent_name="main",
        query="今天做什么",
        thread_id="weak-q-test",
        standing_preview="常驻",
    )
    assert "memory_archival" not in (text or "")
    snap = get_thread_recall("weak-q-test")
    assert snap is not None
    assert snap.get("hit_count", 0) == 0


def test_memory_remember_tool_writes_mem(owned_memory_root: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("evoflow.memory.facade._maybe_enqueue_threshold", lambda *_a, **_k: None)
    # Default injection_mode=asset writes Asset Hub notes; exercise legacy mem_* path here.
    from evoflow.config.memory_config import MemoryConfig, set_memory_config

    set_memory_config(MemoryConfig(injection_mode="legacy"))

    import json

    from evoflow.memory.document_codec import namespace_for_agent_key
    from evoflow.memory.facade import recall
    from evoflow.tools.builtins.memory_remember_tool import memory_remember_tool

    class _RT:
        context = {"agent_name": "main"}
        config = {}

    out = memory_remember_tool.func(
        content="请称呼我为青柠，下班用 bullet 回复",
        runtime=_RT(),
        tool_call_id="t1",
        kind="preference",
        pin=True,
    )
    data = json.loads(out)
    assert data.get("ok") is True
    assert data.get("atom_id")
    hits = recall([namespace_for_agent_key("main")], "青柠", top_k=5, max_chars=500)
    assert any("青柠" in (h.get("content") or "") for h in hits)
