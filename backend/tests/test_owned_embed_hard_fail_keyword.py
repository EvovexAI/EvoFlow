"""Hard EmbeddingError must degrade to keyword-only, not parse_status=failed."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from evoflow.knowledge.embedding.base import EmbeddingError


@pytest.fixture()
def owned_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "knowledge"
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("EVOFLOW_KNOWLEDGE_ROOT", str(root))
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    monkeypatch.setenv("EVOFLOW_OWNED_KB_WORKER", "0")
    from evoflow.knowledge.owned.db import reset_db_state_for_tests
    from evoflow.knowledge.owned.pipeline import clear_embedding_quota_skip_for_tests
    from evoflow.knowledge.owned.worker import stop_owned_kb_worker_for_tests

    stop_owned_kb_worker_for_tests()
    reset_db_state_for_tests()
    clear_embedding_quota_skip_for_tests()
    yield root
    clear_embedding_quota_skip_for_tests()
    stop_owned_kb_worker_for_tests()
    reset_db_state_for_tests()


async def _seed_doc(kb_id: str, body: str, *, vector_enabled: int = 1) -> str:
    from evoflow.knowledge.owned import blob_store
    from evoflow.knowledge.owned.db import db
    from evoflow.knowledge.owned.ids import new_id, utc_now
    from evoflow.knowledge.owned.kb_conn import db_for_kb

    doc_id = new_id("doc_")
    now = utc_now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO kb_bases(
              id, name, chunk_size, chunk_overlap, chunk_strategy,
              embedding_mode, embedding_model, vector_enabled, keyword_enabled,
              created_at, updated_at
            ) VALUES (?,?,512,80,'auto','cloud','doubao-embedding-vision',?,?,?,?)
            """,
            (kb_id, kb_id, vector_enabled, 1, now, now),
        )
    blob_path = blob_store.put_bytes(kb_id, doc_id, "guide.md", body.encode("utf-8"))
    with db_for_kb(kb_id) as conn:
        conn.execute(
            """
            INSERT INTO kb_documents(
              id, kb_id, title, source_type, file_name, mime, size_bytes, content_hash,
              blob_path, folder_path, source_rel_path, parse_status, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)
            """,
            (
                doc_id,
                kb_id,
                "guide",
                "upload",
                "guide.md",
                "text/markdown",
                len(body.encode("utf-8")),
                "x",
                blob_path,
                "",
                "guide.md",
                now,
                now,
            ),
        )
    return doc_id


@pytest.mark.asyncio
async def test_hard_embedding_error_degrades_to_keyword(owned_root: Path):
    from evoflow.knowledge.owned.kb_conn import db_for_kb
    from evoflow.knowledge.owned.pipeline import (
        embedding_quota_skip_active,
        run_parse_index,
    )
    from evoflow.knowledge.owned.retrieve import search_keyword

    kb_id = "kb_hard_embed_fail"
    body = "# 电商内容\n\n银泰 AI 实战报告与关键词检索。\n"
    doc_id = await _seed_doc(kb_id, body)

    err = EmbeddingError(
        "Embedding API error: model doubao-embedding-vision not supported for this account"
    )
    with patch(
        "evoflow.knowledge.owned.pipeline.get_embeddings",
        new=AsyncMock(side_effect=err),
    ):
        await run_parse_index(
            {"id": "job_hard", "kb_id": kb_id, "doc_id": doc_id, "type": "parse_index"},
        )

    with db_for_kb(kb_id) as conn:
        doc = conn.execute(
            "SELECT parse_status, keyword_status, vector_status, chunk_count, index_error "
            "FROM kb_documents WHERE id=?",
            (doc_id,),
        ).fetchone()
        enabled = int(
            conn.execute(
                "SELECT COUNT(*) FROM kb_chunks WHERE doc_id=? AND enabled=1",
                (doc_id,),
            ).fetchone()[0]
        )

    assert doc["parse_status"] == "completed"
    assert doc["keyword_status"] == "ready"
    assert doc["vector_status"] == "degraded"
    assert int(doc["chunk_count"] or 0) > 0
    assert enabled > 0
    assert "not supported" in (doc["index_error"] or "").lower() or "embedding" in (
        doc["index_error"] or ""
    ).lower()

    hits = search_keyword(kb_id, "银泰", top_k=5)
    assert hits, "hard embed failure must still leave keyword hits"

    cooled, _reason = embedding_quota_skip_active()
    assert cooled is True


@pytest.mark.asyncio
async def test_skip_embedding_keyword_only_reason(owned_root: Path):
    from evoflow.knowledge.owned.kb_conn import db_for_kb
    from evoflow.knowledge.owned.pipeline import run_parse_index
    from evoflow.knowledge.owned.retrieve import search_keyword

    kb_id = "kb_keyword_only_skip"
    body = "# 教材\n\nAgent 技术陪练关键词检索。\n"
    doc_id = await _seed_doc(kb_id, body, vector_enabled=0)

    with patch(
        "evoflow.knowledge.owned.pipeline.get_embeddings",
        new=AsyncMock(side_effect=AssertionError("must not call embed")),
    ):
        await run_parse_index(
            {
                "id": "job_skip",
                "kb_id": kb_id,
                "doc_id": doc_id,
                "type": "parse_index",
            },
            skip_embedding=True,
            skip_embedding_reason="此库已设为仅关键词检索",
        )

    with db_for_kb(kb_id) as conn:
        doc = conn.execute(
            "SELECT parse_status, vector_status, index_error FROM kb_documents WHERE id=?",
            (doc_id,),
        ).fetchone()

    assert doc["parse_status"] == "completed"
    assert doc["vector_status"] == "degraded"
    assert "仅关键词" in (doc["index_error"] or "")
    assert search_keyword(kb_id, "陪练", top_k=5)


@pytest.mark.asyncio
async def test_heal_embedding_failed_docs(owned_root: Path):
    from evoflow.knowledge.owned import service as owned_service
    from evoflow.knowledge.owned.db import db
    from evoflow.knowledge.owned.ids import new_id, utc_now
    from evoflow.knowledge.owned.kb_conn import db_for_kb
    from evoflow.knowledge.owned import blob_store

    kb_id = "kb_heal_embed"
    now = utc_now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO kb_bases(
              id, name, chunk_size, chunk_overlap, chunk_strategy,
              embedding_mode, embedding_model, vector_enabled, keyword_enabled,
              created_at, updated_at
            ) VALUES (?,?,512,80,'auto','cloud','doubao-embedding-vision',1,1,?,?)
            """,
            (kb_id, kb_id, now, now),
        )
    doc_id = new_id("doc_")
    blob_path = blob_store.put_bytes(
        kb_id, doc_id, "x.md", "# heal\n\nvector failed doc\n".encode("utf-8")
    )
    with db_for_kb(kb_id) as conn:
        conn.execute(
            """
            INSERT INTO kb_documents(
              id, kb_id, title, source_type, file_name, mime, size_bytes, content_hash,
              blob_path, folder_path, source_rel_path, parse_status, vector_status,
              error_message, index_error, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'failed','failed',?,?,?,?)
            """,
            (
                doc_id,
                kb_id,
                "heal",
                "upload",
                "x.md",
                "text/markdown",
                12,
                "h",
                blob_path,
                "",
                "x.md",
                "EmbeddingError: doubao-embedding-vision failed",
                "EmbeddingError: doubao-embedding-vision failed",
                now,
                now,
            ),
        )

    res = owned_service.requeue_embedding_failed_as_keyword(kb_id, limit=10)
    assert res["requeued"] == 1

    with db() as conn:
        job = conn.execute(
            "SELECT type, state, payload_json FROM kb_jobs WHERE doc_id=? ORDER BY created_at DESC LIMIT 1",
            (doc_id,),
        ).fetchone()
    assert job is not None
    assert job["state"] == "queued"
    assert "skip_embedding" in (job["payload_json"] or "")
