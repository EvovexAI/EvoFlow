"""Dry-run sync checklist for owned KB folder import."""

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


def test_preview_local_folder_sync_create_update_prune(owned_root: Path):
    from evoflow.knowledge.owned import service

    kb_id = "kb_sync_preview"
    _register_kb(kb_id)
    root = owned_root / "docs"
    root.mkdir()
    (root / "a.md").write_text("hello", encoding="utf-8")
    (root / "b.md").write_text("one", encoding="utf-8")
    nested = root / "guide"
    nested.mkdir()
    (nested / "c.md").write_text("nested", encoding="utf-8")
    (root / "skip.py").write_text("print(1)", encoding="utf-8")
    (root / ".hidden").mkdir()
    (root / ".hidden" / "secret.md").write_text("nope", encoding="utf-8")

    first = service.import_local_folder(kb_id, root, upsert=True, prune_missing=False)
    assert first["created"] >= 3

    (root / "a.md").write_text("hello-changed", encoding="utf-8")
    (root / "new.md").write_text("brand", encoding="utf-8")
    (root / "b.md").unlink()

    plan = service.preview_local_folder_sync(kb_id, root)
    assert plan["sourcePath"] == str(root.resolve())
    assert plan["createTotal"] >= 1
    assert any(item["fileName"] == "new.md" for item in plan["create"])
    assert plan["updateTotal"] >= 1
    assert any(item["fileName"] == "a.md" for item in plan["update"])
    assert plan["pruneTotal"] >= 1
    assert any(item["fileName"] == "b.md" for item in plan["prune"])
    assert plan["hasChanges"] is True
    assert all(item["fileName"] != "skip.py" for item in plan["create"])
    assert all(".hidden" not in item["relPath"] for item in plan["create"])

    remembered = service.preview_resync_base(kb_id)
    assert remembered["sourcePath"] == plan["sourcePath"]
    assert remembered["createTotal"] == plan["createTotal"]
