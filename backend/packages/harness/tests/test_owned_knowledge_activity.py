"""Tests for owned KB activity trail."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest


@pytest.fixture()
def owned_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    home = tmp_path / "evoflow-home"
    home.mkdir()
    monkeypatch.setenv("EVOFLOW_HOME", str(home))
    monkeypatch.setenv("EVOFLOW_KNOWLEDGE_ROOT", str(home / "knowledge"))
    from evoflow.knowledge.owned import db as owned_db
    from evoflow.knowledge.owned import worker as owned_worker
    from evoflow.knowledge.owned.worker import stop_owned_kb_worker_for_tests

    stop_owned_kb_worker_for_tests()
    monkeypatch.setattr(owned_worker, "ensure_owned_kb_worker_started", lambda: None)
    owned_db.reset_db_state_for_tests()
    yield home
    stop_owned_kb_worker_for_tests()


def test_activity_record_list_and_prune(owned_home: Path):
    from evoflow.knowledge.owned import activity

    kb = "kb_test"
    a1 = activity.record(kb, "base.create", title="库A", detail={"name": "库A"})
    assert a1 and a1["action"] == "base.create"
    a2 = activity.record(
        kb,
        "ask",
        title="问题",
        detail={"query": "x" * 200},
    )
    assert a2
    assert len(a2["detail"].get("queryPreview") or "") <= 81
    assert "query" not in a2["detail"]

    items = activity.list_activities(kb_id=kb, limit=10)
    assert len(items) >= 2
    assert items[0]["createdAt"] >= items[1]["createdAt"]

    assert activity.record(kb, "nope.action") is None

    from evoflow.knowledge.owned.db import db

    with db() as conn:
        conn.execute(
            "UPDATE kb_activity SET created_at=? WHERE id=?",
            ("2000-01-01T00:00:00Z", a1["id"]),
        )
    deleted = activity.prune(kb)
    assert deleted >= 1
    left = {x["id"] for x in activity.list_activities(kb_id=kb, limit=50)}
    assert a1["id"] not in left
    assert a2["id"] in left


def test_upload_and_ask_write_activity(owned_home: Path, monkeypatch: pytest.MonkeyPatch):
    from evoflow.knowledge.owned import jobs
    from evoflow.knowledge.owned import pipeline as pipeline_mod
    from evoflow.knowledge.owned import service as owned_service
    from evoflow.knowledge.owned.pipeline import run_parse_index

    async def _fake_embeddings(texts, model_config=None, **kwargs):
        return [[0.1] * 8 for _ in texts]

    monkeypatch.setattr(pipeline_mod, "get_embeddings", _fake_embeddings)

    base = owned_service.create_base(
        {
            "name": "轨迹库",
            "embeddingMode": "local",
            "embeddingModel": "BAAI/bge-small-zh-v1.5",
            "summaryEnabled": False,
        }
    )
    kb_id = base["id"]
    doc = owned_service.upload_manual_markdown(
        kb_id,
        title="笔记",
        content="# hello\n\nworld activity trail\n",
    )
    job = jobs.get_job(doc["latestJobId"])
    assert job is not None
    asyncio.run(run_parse_index(job))

    acts = owned_service.list_activities(kb_id=kb_id, limit=20)
    actions = {a["action"] for a in acts}
    assert "base.create" in actions
    assert "doc.manual" in actions

    chunks = owned_service.list_chunks(doc["id"])
    assert chunks

    async def _fake_search(kb_id_arg, query, *, mode="hybrid", top_k=8, **kwargs):
        return {
            "items": [
                {
                    "chunkId": chunks[0]["id"],
                    "docId": doc["id"],
                    "title": "笔记",
                    "fileName": "笔记.md",
                    "content": "world activity trail",
                    "score": 1.0,
                }
            ],
            "total": 1,
            "mode": mode,
            "degraded": False,
        }

    monkeypatch.setattr(owned_service, "search", _fake_search)

    async def _boom(*_a, **_k):
        raise RuntimeError("no llm")

    monkeypatch.setattr(
        "evoflow.context.internal_model_invoke.ainvoke_internal_chat_model",
        _boom,
    )
    monkeypatch.setattr("evoflow.models.create_chat_model", lambda **_k: object())

    out = asyncio.run(owned_service.ask(kb_id, "讲了什么？", top_k=3))
    assert out.get("answer")
    acts2 = owned_service.list_activities(kb_id=kb_id, limit=20)
    assert any(a["action"] == "ask" for a in acts2)
