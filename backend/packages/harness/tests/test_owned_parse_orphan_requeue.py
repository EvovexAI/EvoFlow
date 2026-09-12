"""Stuck processing docs should fail cleanly and be requeueable."""

from __future__ import annotations

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
    owned_db.reset_db_state_for_tests()


def test_job_permanent_error_marks_doc_failed(owned_home: Path) -> None:
    del owned_home
    from evoflow.knowledge.owned import jobs, service
    from evoflow.knowledge.owned.db import db
    from evoflow.knowledge.owned.ids import utc_now

    base = service.create_base({"name": "orphan-kb", "summaryEnabled": False})
    kb_id = base["id"]
    doc = service.upload_manual_markdown(
        kb_id, title="stuck", content="hello world " * 20, folder_path="inbox"
    )
    doc_id = doc["id"]
    # Drop auto-enqueued jobs; insert a clean one we control.
    with db() as conn:
        conn.execute("DELETE FROM kb_jobs WHERE doc_id=?", (doc_id,))
        conn.execute(
            "UPDATE kb_documents SET parse_status='processing', updated_at=? WHERE id=?",
            (utc_now(), doc_id),
        )
    job = jobs.enqueue(kb_id=kb_id, doc_id=doc_id, type="parse_index", priority=100)
    claimed = jobs.claim_next("test-worker")
    assert claimed is not None
    assert claimed["id"] == job["id"]
    jobs.complete(job["id"], error="embedding API rate limit (429)", permanent=True)

    refreshed = service.get_document(doc_id)
    assert refreshed is not None
    assert refreshed.get("parseStatus") == "failed"
    assert "429" in str(refreshed.get("errorMessage") or "")


@pytest.mark.asyncio
async def test_skip_embedding_still_completes_chunks(owned_home: Path) -> None:
    del owned_home
    from evoflow.knowledge.owned import jobs, service
    from evoflow.knowledge.owned.db import db
    from evoflow.knowledge.owned.pipeline import run_parse_index

    base = service.create_base({"name": "no-emb", "summaryEnabled": False})
    kb_id = base["id"]
    doc = service.upload_manual_markdown(
        kb_id, title="kw-only", content="关键词检索仍可用 " * 30, folder_path="inbox"
    )
    doc_id = doc["id"]
    with db() as conn:
        conn.execute("DELETE FROM kb_jobs WHERE doc_id=?", (doc_id,))
    job = jobs.enqueue(kb_id=kb_id, doc_id=doc_id, type="parse_index", priority=100)
    await run_parse_index(
        job,
        skip_embedding=True,
        skip_embedding_reason="embedding API unavailable (missing API key)",
    )
    refreshed = service.get_document(doc_id)
    assert refreshed is not None
    assert refreshed.get("parseStatus") == "completed"
    assert int(refreshed.get("chunkCount") or 0) >= 1
    assert "跳过" in str(refreshed.get("errorMessage") or "")


def test_requeue_orphan_processing_docs(owned_home: Path) -> None:
    del owned_home
    from evoflow.knowledge.owned import jobs, service
    from evoflow.knowledge.owned.db import db
    from evoflow.knowledge.owned.ids import utc_now

    base = service.create_base({"name": "requeue-kb", "summaryEnabled": False})
    kb_id = base["id"]
    doc = service.upload_manual_markdown(
        kb_id, title="orphan", content="body", folder_path="inbox"
    )
    doc_id = doc["id"]
    # Force processing with no active job (mimic deleted/exhausted job).
    with db() as conn:
        conn.execute(
            "UPDATE kb_documents SET parse_status='processing', updated_at=? WHERE id=?",
            (utc_now(), doc_id),
        )
        conn.execute("DELETE FROM kb_jobs WHERE doc_id=?", (doc_id,))

    orphans = jobs.list_orphan_parse_docs(kb_id)
    assert any(str(r.get("doc_id")) == doc_id for r in orphans)

    result = service.requeue_orphan_parse_docs(kb_id)
    assert result["requeued"] >= 1
    refreshed = service.get_document(doc_id)
    assert refreshed is not None
    assert refreshed.get("parseStatus") == "pending"
    active = jobs.list_jobs(kb_id, states=["queued", "running"])
    assert any(j.get("docId") == doc_id for j in active)
