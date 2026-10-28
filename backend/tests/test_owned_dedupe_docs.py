"""Duplicate folder_path+file_name rows must collapse for counts / list."""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture()
def owned_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "knowledge"
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("EVOFLOW_KNOWLEDGE_ROOT", str(root))
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    from evoflow.knowledge.owned.db import reset_db_state_for_tests

    reset_db_state_for_tests()
    yield root
    reset_db_state_for_tests()


def _register_kb(kb_id: str) -> None:
    from evoflow.knowledge.owned.db import db
    from evoflow.knowledge.owned.ids import utc_now

    now = utc_now()
    with db() as conn:
        conn.execute(
            "INSERT INTO kb_bases (id, name, storage_dir, created_at, updated_at)"
            " VALUES (?, ?, '', ?, ?)",
            (kb_id, kb_id, now, now),
        )


def test_dedupe_keeps_newest_and_upload_upserts(owned_root: Path):
    from evoflow.knowledge.owned import service
    from evoflow.knowledge.owned.ids import new_id, utc_now
    from evoflow.knowledge.owned.kb_conn import db_for_kb

    kb_id = "kb_dedupe"
    _register_kb(kb_id)

    d1 = service.upload_bytes(kb_id, file_name="readme.md", data=b"v1", folder_path="")
    assert d1["id"]

    # Older duplicate (pre-upsert bug); keep newest = d1.
    with db_for_kb(kb_id) as conn:
        conn.execute(
            """
            INSERT INTO kb_documents(
              id, kb_id, title, source_type, file_name, mime, size_bytes, content_hash,
              blob_path, folder_path, source_rel_path, parse_status, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)
            """,
            (
                new_id("doc_"),
                kb_id,
                "readme",
                "upload",
                "readme.md",
                "text/markdown",
                2,
                "deadbeef",
                "",
                "",
                "readme.md",
                "2000-01-01T00:00:00Z",
                "2000-01-01T00:00:00Z",
            ),
        )

    removed = service.dedupe_documents_by_rel_path(kb_id)
    assert removed == 1
    docs = [d for d in service.list_documents(kb_id) if d["fileName"] == "readme.md"]
    assert len(docs) == 1
    assert docs[0]["id"] == d1["id"]

    d2 = service.upload_bytes(kb_id, file_name="readme.md", data=b"v2-longer", folder_path="")
    assert d2.get("id") == d1["id"]
    assert len([d for d in service.list_documents(kb_id) if d["fileName"] == "readme.md"]) == 1
