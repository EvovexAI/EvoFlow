"""Tests for the knowledge-base "open location" shortcut (folder reveal).

The KB detail page exposes an 「打开位置」 button that reveals the KB's folder in
the OS file manager. It prefers the user's import source folder and falls back to
the KB's own data directory. This requires the API to hand the frontend a usable
absolute path even for legacy bases whose ``storage_dir`` was never stamped.
"""

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
    # Unit tests run pipelines synchronously; avoid background worker races.
    monkeypatch.setattr(owned_worker, "ensure_owned_kb_worker_started", lambda: None)
    owned_db.reset_db_state_for_tests()
    yield home
    stop_owned_kb_worker_for_tests()


def test_base_exposes_resolved_storage_dir(owned_home: Path) -> None:
    """``resolvedStorageDir`` must be an absolute path on every base."""
    from evoflow.knowledge.owned import service as owned_service

    base = owned_service.create_base({"name": "打开位置测试库", "summaryEnabled": False})
    listed = next(b for b in owned_service.list_bases() if b["id"] == base["id"])
    resolved = str(listed.get("resolvedStorageDir") or "")
    assert resolved, "resolvedStorageDir missing — open-location button would be disabled"
    assert Path(resolved).is_absolute()


def test_resolved_storage_dir_survives_missing_storage_dir(owned_home: Path) -> None:
    """Legacy bases (``storage_dir=''``) still resolve to a real directory."""
    from evoflow.knowledge.owned import service as owned_service
    from evoflow.knowledge.owned.db import db

    base = owned_service.create_base({"name": "legacy 空目录库", "summaryEnabled": False})
    # Simulate a pre-split base that never got ``storage_dir`` stamped.
    with db() as conn:
        conn.execute("UPDATE kb_bases SET storage_dir='' WHERE id=?", (base["id"],))

    listed = next(b for b in owned_service.list_bases() if b["id"] == base["id"])
    assert not str(listed.get("storageDir") or ""), "precondition: storage_dir cleared"
    resolved = str(listed.get("resolvedStorageDir") or "")
    assert resolved and Path(resolved).is_absolute()


def test_base_reports_source_path_for_reveal(owned_home: Path, tmp_path: Path) -> None:
    """An imported folder becomes the preferred reveal target via syncSourcePath."""
    from evoflow.knowledge.owned import service as owned_service

    src = tmp_path / "导入源目录"
    src.mkdir()
    (src / "note.md").write_text("# 笔记\n\n内容\n", encoding="utf-8")

    base = owned_service.create_base({"name": "源目录库", "summaryEnabled": False})
    owned_service.import_local_folder(base["id"], src, upsert=True)

    listed = next(b for b in owned_service.list_bases() if b["id"] == base["id"])
    assert listed.get("syncSourceType") == "folder"
    assert str(listed.get("syncSourcePath") or "") == str(src.resolve())
    # Data dir stays distinct from the source dir — the button picks source first.
    assert str(listed.get("resolvedStorageDir") or "") != str(src.resolve())
