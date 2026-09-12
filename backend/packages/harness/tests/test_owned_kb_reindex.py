"""Owned KB reindex for existing unvectorized bases."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest


@pytest.fixture()
def owned_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    home = tmp_path / "evoflow-home"
    home.mkdir()
    monkeypatch.setenv("EVOFLOW_HOME", str(home))
    monkeypatch.setenv("EVOFLOW_KNOWLEDGE_ROOT", str(home / "knowledge"))
    from evoflow.knowledge.owned import db as owned_db
    from evoflow.knowledge.owned.worker import stop_owned_kb_worker_for_tests

    stop_owned_kb_worker_for_tests()
    owned_db.reset_db_state_for_tests()
    yield home
    stop_owned_kb_worker_for_tests()


_BINDING = {
    "embedding_mode": "cloud",
    "embedding_model": "doubao-embedding-vision",
    "embedding_base_url": "https://example.test",
    "embedding_model_ref": "plan-emb",
    "embedding_api_key": "",
    "from_registry": True,
}


def _insert_doc(conn, *, doc_id: str, kb_id: str, title: str) -> None:
    conn.execute(
        """
        INSERT INTO kb_documents (
          id, kb_id, title, source_type, file_name, mime, size_bytes, content_hash,
          blob_path, folder_path, sort_order, parse_status, error_message, chunk_count,
          summary_status, summary_text, tags_json, frontmatter_json, source_rel_path,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, 'upload', ?, 'text/markdown', 0, '',
          '', '', 0, 'ready', '', 0,
          'none', '', '[]', '{}', '',
          datetime('now'), datetime('now')
        )
        """,
        (doc_id, kb_id, title, title),
    )


def test_reindex_base_queues_docs_when_dim_null(owned_home: Path):
    from evoflow.knowledge.owned import jobs, service

    with (
        patch.object(service, "ensure_owned_kb_worker_started"),
        patch.object(service, "resolve_create_binding", return_value=_BINDING),
    ):
        base = service.create_base({"name": "kb-reindex", "embeddingModelRef": "plan-emb"})
        kb_id = base["id"]
        with service.db() as conn:
            _insert_doc(conn, doc_id="d1", kb_id=kb_id, title="a.md")
            _insert_doc(conn, doc_id="d2", kb_id=kb_id, title="b.md")
            conn.execute("UPDATE kb_bases SET embedding_dim=NULL WHERE id=?", (kb_id,))

        queued: list[str] = []

        def _enqueue(**kwargs):
            queued.append(str(kwargs.get("doc_id") or ""))
            return "job"

        with patch.object(jobs, "enqueue", side_effect=_enqueue):
            out = service.reindex_base(kb_id, force=True)

        assert out["reindexQueued"] == 2
        assert set(queued) == {"d1", "d2"}


def test_update_base_same_model_queues_when_dim_null(owned_home: Path):
    from evoflow.knowledge.owned import jobs, service

    with (
        patch.object(service, "ensure_owned_kb_worker_started"),
        patch.object(service, "resolve_create_binding", return_value=_BINDING),
    ):
        base = service.create_base({"name": "kb2", "embeddingModelRef": "plan-emb"})
        kb_id = base["id"]
        with service.db() as conn:
            _insert_doc(conn, doc_id="dx", kb_id=kb_id, title="x.md")
            conn.execute("UPDATE kb_bases SET embedding_dim=NULL WHERE id=?", (kb_id,))

        queued: list[str] = []
        with patch.object(
            jobs, "enqueue", side_effect=lambda **kw: queued.append(kw["doc_id"]) or "j"
        ):
            out = service.update_base(kb_id, {"embeddingModelRef": "plan-emb"})

        assert out.get("reindexQueued") == 1
        assert queued == ["dx"]
