"""Additional P1 tests: upsert sync, wikilinks, tags, heading chunks."""

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


def test_import_folder_upsert(owned_home: Path, tmp_path: Path):
    from evoflow.knowledge.owned import service as owned_service

    root = tmp_path / "notes"
    root.mkdir()
    (root / "a.md").write_text("# A\nhello\n", encoding="utf-8")
    base = owned_service.create_base({"name": "同步库", "summaryEnabled": False})
    kb = base["id"]

    r1 = owned_service.import_local_folder(kb, root, upsert=True)
    assert r1["created"] == 1
    assert r1["updated"] == 0
    assert r1["unchanged"] == 0
    doc_id = r1["items"][0]["id"]

    r2 = owned_service.import_local_folder(kb, root, upsert=True)
    assert r2["created"] == 0
    assert r2["updated"] == 0
    assert r2["unchanged"] == 1

    (root / "a.md").write_text("# A\nhello world\n", encoding="utf-8")
    r3 = owned_service.import_local_folder(kb, root, upsert=True)
    assert r3["updated"] == 1
    assert r3["items"][0]["id"] == doc_id

    (root / "b.md").write_text("# B\n", encoding="utf-8")
    (root / "a.md").unlink()
    r4 = owned_service.import_local_folder(kb, root, upsert=True, prune_missing=True)
    assert r4["created"] == 1
    assert r4["pruned"] == 1
    docs = owned_service.list_documents(kb)
    assert len(docs) == 1
    assert docs[0]["fileName"] == "b.md"


def test_doc_wikilinks_and_tags(owned_home: Path, monkeypatch: pytest.MonkeyPatch):
    from evoflow.knowledge.owned import jobs
    from evoflow.knowledge.owned import pipeline as pipeline_mod
    from evoflow.knowledge.owned import service as owned_service
    from evoflow.knowledge.owned.pipeline import run_parse_index

    async def _fake_embeddings(texts, model_config=None, **kwargs):
        return [[0.1] * 8 for _ in texts]

    monkeypatch.setattr(pipeline_mod, "get_embeddings", _fake_embeddings)

    base = owned_service.create_base(
        {"name": "链接库", "summaryEnabled": False, "chunkStrategy": "auto"}
    )
    kb = base["id"]
    a = owned_service.upload_manual_markdown(
        kb,
        title="Alpha",
        content="---\ntags: [core, demo]\n---\n\nSee [[Beta]] and #inline\n",
    )
    b = owned_service.upload_manual_markdown(
        kb,
        title="Beta",
        content="# Beta\n\nBack to [[Alpha]]\n",
    )
    for doc in (a, b):
        job = jobs.get_job(doc["latestJobId"])
        assert job
        asyncio.run(run_parse_index(job))

    a2 = owned_service.get_document(a["id"])
    assert "core" in (a2.get("tags") or [])
    assert "demo" in (a2.get("tags") or [])
    assert "inline" in (a2.get("tags") or [])

    links = owned_service.get_document_links(a["id"])
    assert links
    assert any(x.get("docId") == b["id"] for x in links["outLinks"])
    back = owned_service.get_document_links(b["id"])
    assert any(x.get("docId") == a["id"] for x in back["inLinks"])

    graph = owned_service.doc_graph(kb)
    assert len(graph["nodes"]) >= 2
    assert graph["edges"]

    items = asyncio.run(
        owned_service.search(kb, "See", mode="keyword", top_k=8, tags=["core"])
    )
    assert items["items"]
    assert all("core" in (h.get("tags") or []) for h in items["items"])


def test_heading_chunk_strategy():
    from evoflow.knowledge.owned.chunking import split_text

    text = """# Intro

前言很长一段文字用于填充。

## Detail

细节段落一。

### Nested

嵌套内容。
"""
    pieces = split_text(text, chunk_size=80, chunk_overlap=10, strategy="heading")
    assert pieces
    assert any(p.heading_path for p in pieces)

    auto = split_text(text * 3, chunk_size=64, chunk_overlap=8, strategy="auto")
    assert auto


def test_split_handles_long_unbroken_token():
    from evoflow.knowledge.owned.chunking import split_text

    # No whitespace/punctuation — must not raise on empty separator fallback.
    blob = "字" * 2000
    pieces = split_text(blob, chunk_size=120, chunk_overlap=10, strategy="recursive")
    assert pieces
    assert sum(len(p.content) for p in pieces) >= 1900
