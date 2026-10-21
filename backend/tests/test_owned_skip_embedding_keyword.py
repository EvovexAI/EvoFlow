"""skip_embedding must publish enabled chunks + FTS for keyword search.

Regression: lean desktop installs (no embedding model) took the skip_embedding
path, left chunks at enabled=0 without FTS, and search (which requires
enabled=1) returned zero hits — including the builtin user guide used by 小V.
"""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture()
def owned_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "knowledge"
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("EVOFLOW_KNOWLEDGE_ROOT", str(root))
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    monkeypatch.setenv("EVOFLOW_OWNED_KB_WORKER", "0")
    from evoflow.knowledge.owned.db import reset_db_state_for_tests
    from evoflow.knowledge.owned.worker import stop_owned_kb_worker_for_tests

    stop_owned_kb_worker_for_tests()
    reset_db_state_for_tests()
    yield root
    stop_owned_kb_worker_for_tests()
    reset_db_state_for_tests()


@pytest.mark.asyncio
async def test_skip_embedding_enables_chunks_and_keyword_search(owned_root: Path):
    from evoflow.knowledge.owned import blob_store
    from evoflow.knowledge.owned.db import db
    from evoflow.knowledge.owned.ids import new_id, utc_now
    from evoflow.knowledge.owned.kb_conn import db_for_kb
    from evoflow.knowledge.owned.pipeline import run_parse_index
    from evoflow.knowledge.owned.retrieve import search_keyword

    kb_id = "kb_skip_emb_test"
    doc_id = new_id("doc_")
    now = utc_now()
    body = "# 智能体员工\n\n如何雇佣第一个智能体员工，并配置知识库检索。\n"

    with db() as conn:
        conn.execute(
            """
            INSERT INTO kb_bases(
              id, name, chunk_size, chunk_overlap, chunk_strategy,
              embedding_mode, embedding_model, vector_enabled, keyword_enabled,
              created_at, updated_at
            ) VALUES (?,?,512,80,'auto','cloud','text-embedding-3-small',1,1,?,?)
            """,
            (kb_id, "skip-emb", now, now),
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

    await run_parse_index(
        {"id": "job_test", "kb_id": kb_id, "doc_id": doc_id, "type": "parse_index"},
        skip_embedding=True,
        skip_embedding_reason="test: no embedding",
    )

    with db_for_kb(kb_id) as conn:
        enabled = conn.execute(
            "SELECT enabled, COUNT(*) c FROM kb_chunks WHERE doc_id=? GROUP BY enabled",
            (doc_id,),
        ).fetchall()
        enabled_map = {int(r["enabled"]): int(r["c"]) for r in enabled}
        fts_n = int(conn.execute("SELECT COUNT(*) FROM kb_chunks_fts WHERE doc_id=?", (doc_id,)).fetchone()[0])
        doc = conn.execute(
            "SELECT parse_status, keyword_status, vector_status, chunk_count FROM kb_documents WHERE id=?",
            (doc_id,),
        ).fetchone()

    assert enabled_map.get(1, 0) > 0, "skip_embedding must enable chunks for search"
    assert enabled_map.get(0, 0) == 0
    assert fts_n > 0, "skip_embedding must write FTS rows"
    assert doc["parse_status"] == "completed"
    assert doc["keyword_status"] == "ready"
    assert doc["vector_status"] == "degraded"

    hits = search_keyword(kb_id, "智能体员工", top_k=5)
    assert hits, "keyword search must return hits after skip_embedding publish"
    assert any("智能体" in str(h.get("content") or "") for h in hits)


def test_requeue_unpublished_keyword_docs(owned_root: Path):
    from evoflow.knowledge.owned import service
    from evoflow.knowledge.owned.db import db
    from evoflow.knowledge.owned.ids import utc_now
    from evoflow.knowledge.owned.kb_conn import db_for_kb

    kb_id = "kb_unpublished"
    doc_id = "doc_unpublished"
    now = utc_now()
    with db() as conn:
        conn.execute(
            "INSERT INTO kb_bases (id, name, created_at, updated_at) VALUES (?,?,?,?)",
            (kb_id, kb_id, now, now),
        )
    with db_for_kb(kb_id) as conn:
        conn.execute(
            """
            INSERT INTO kb_documents(
              id, kb_id, title, parse_status, keyword_status, chunk_count, created_at, updated_at
            ) VALUES (?,?,?,'completed','ready',1,?,?)
            """,
            (doc_id, kb_id, "stuck", now, now),
        )
        conn.execute(
            """
            INSERT INTO kb_chunks(
              id, kb_id, doc_id, ordinal, content, enabled, created_at, updated_at
            ) VALUES (?,?,?,0,'智能体知识库内容',0,?,?)
            """,
            ("chk_stuck", kb_id, doc_id, now, now),
        )

    result = service.requeue_unpublished_keyword_docs(kb_id, limit=10)
    assert result["requeued"] == 1

    with db_for_kb(kb_id) as conn:
        row = conn.execute(
            "SELECT parse_status FROM kb_documents WHERE id=?", (doc_id,)
        ).fetchone()
    assert row["parse_status"] == "pending"

    with db() as conn:
        n = int(
            conn.execute(
                "SELECT COUNT(*) FROM kb_jobs WHERE kb_id=? AND doc_id=? AND type='parse_index' AND state='queued'",
                (kb_id, doc_id),
            ).fetchone()[0]
        )
    assert n >= 1
