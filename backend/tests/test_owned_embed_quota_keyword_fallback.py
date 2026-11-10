"""Cloud embedding quota must not leave documents unsearchable.

When parse_index hits EmbeddingError 429 / monthly quota, publish keyword + FTS
(vector_status=degraded) instead of failing parse/keyword/vector together.
"""

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


async def _seed_doc(kb_id: str, body: str) -> str:
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
            ) VALUES (?,?,512,80,'auto','cloud','text-embedding-3-small',1,1,?,?)
            """,
            (kb_id, kb_id, now, now),
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
async def test_monthly_quota_degrades_to_keyword_search(owned_root: Path):
    from evoflow.knowledge.owned.kb_conn import db_for_kb
    from evoflow.knowledge.owned.pipeline import (
        embedding_quota_skip_active,
        run_parse_index,
    )
    from evoflow.knowledge.owned.retrieve import search_keyword

    kb_id = "kb_quota_fallback"
    body = "# 车险报价\n\n平安保险车险报价申请与知识库检索。\n"
    doc_id = await _seed_doc(kb_id, body)

    err = EmbeddingError(
        "Embedding API rate limit (429): monthly usage quota exceeded for "
        "embeddings, reset at 2026-11-21 23:59:59 +0800"
    )
    with patch(
        "evoflow.knowledge.owned.pipeline.get_embeddings",
        new=AsyncMock(side_effect=err),
    ):
        await run_parse_index(
            {"id": "job_quota", "kb_id": kb_id, "doc_id": doc_id, "type": "parse_index"},
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
        fts_n = int(
            conn.execute(
                "SELECT COUNT(*) FROM kb_chunks_fts WHERE doc_id=?",
                (doc_id,),
            ).fetchone()[0]
        )

    assert doc["parse_status"] == "completed"
    assert doc["keyword_status"] == "ready"
    assert doc["vector_status"] == "degraded"
    assert int(doc["chunk_count"] or 0) > 0
    assert enabled > 0
    assert fts_n > 0
    assert "月" in (doc["index_error"] or "") or "quota" in (doc["index_error"] or "").lower() or "429" in (
        doc["index_error"] or ""
    )

    hits = search_keyword(kb_id, "车险报价", top_k=5)
    assert hits, "quota failure must still leave keyword hits"

    cooled, reason = embedding_quota_skip_active()
    assert cooled is True
    assert reason and ("429" in reason or "quota" in reason.lower())


@pytest.mark.asyncio
async def test_quota_cooldown_lets_worker_skip_without_api(owned_root: Path):
    """After one quota hit, subsequent jobs should skip embed without calling API."""
    from evoflow.knowledge.owned.pipeline import arm_embedding_quota_skip
    from evoflow.knowledge.owned.retrieve import search_keyword
    from evoflow.knowledge.owned.worker import _dispatch

    arm_embedding_quota_skip("monthly usage quota (test)", seconds=3600)

    kb_id = "kb_quota_cooldown"
    body = "# 交强险\n\n交强险保单与批改流程说明。\n"
    doc_id = await _seed_doc(kb_id, body)

    embed = AsyncMock(side_effect=AssertionError("must not call cloud embed during cooldown"))
    with patch("evoflow.knowledge.owned.pipeline.get_embeddings", new=embed):
        # Worker path: cooldown → skip_embedding=True before run_parse_index
        await _dispatch(
            {
                "id": "job_cool",
                "kb_id": kb_id,
                "doc_id": doc_id,
                "type": "parse_index",
            }
        )

    embed.assert_not_awaited()
    hits = search_keyword(kb_id, "交强险", top_k=5)
    assert hits
