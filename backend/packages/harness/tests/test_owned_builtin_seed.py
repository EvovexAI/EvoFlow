"""Seed packaged user guide into owned knowledge bases."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.knowledge.owned import builtin_seed as seed
from evoflow.knowledge.owned import db as owned_db
from evoflow.knowledge.owned import service as owned_service
from evoflow.knowledge.owned.worker import stop_owned_kb_worker_for_tests
from evoflow.knowledge.vault import builtin as bv


@pytest.fixture()
def owned_seed_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    home = tmp_path / "evoflow-home"
    home.mkdir()
    src = tmp_path / "docs_user"
    src.mkdir()
    (src / "README.md").write_text("# User guide\n\nHow to use EvoFlow.\n", encoding="utf-8")
    (src / "guides").mkdir()
    (src / "guides" / "quick.md").write_text("# Quick start\n\nInstall then open panel.\n", encoding="utf-8")

    monkeypatch.setenv("EVOFLOW_HOME", str(home))
    monkeypatch.setenv("EVOFLOW_KNOWLEDGE_ROOT", str(home / "knowledge"))
    monkeypatch.setattr(bv, "bundled_user_guide_src", lambda: src)
    from evoflow.knowledge.owned import worker as owned_worker

    stop_owned_kb_worker_for_tests()
    monkeypatch.setattr(owned_worker, "ensure_owned_kb_worker_started", lambda: None)
    monkeypatch.setattr(owned_service, "ensure_owned_kb_worker_started", lambda: None)
    owned_db.reset_db_state_for_tests()
    yield home, src
    stop_owned_kb_worker_for_tests()
    owned_db.reset_db_state_for_tests()


def test_ensure_builtin_owned_seeds_user_guide(owned_seed_home):
    _home, src = owned_seed_home
    first = seed.ensure_builtin_owned_knowledge()
    assert first["ok"] is True
    assert first["action"] == "synced"
    assert first["kbId"] == seed.BUILTIN_OWNED_USER_GUIDE_KB_ID

    base = owned_service.get_base(seed.BUILTIN_OWNED_USER_GUIDE_KB_ID)
    assert base is not None
    assert base["name"] == bv.BUILTIN_USER_GUIDE_VAULT_NAME
    assert base["builtin"] is True
    docs = owned_service.list_documents(base["id"])
    assert len(docs) >= 2
    names = {d["fileName"] for d in docs}
    assert "README.md" in names
    assert "quick.md" in names

    again = seed.ensure_builtin_owned_knowledge()
    assert again["action"] == "unchanged"
    assert again["docCount"] == len(docs)


def test_ensure_builtin_owned_resyncs_when_source_changes(owned_seed_home):
    _home, src = owned_seed_home
    seed.ensure_builtin_owned_knowledge()
    (src / "guides" / "new.md").write_text("# New page\n\nFresh content.\n", encoding="utf-8")

    updated = seed.ensure_builtin_owned_knowledge()
    assert updated["action"] == "synced"
    assert int(updated.get("created") or 0) >= 1

    docs = owned_service.list_documents(seed.BUILTIN_OWNED_USER_GUIDE_KB_ID)
    assert any(d["fileName"] == "new.md" for d in docs)


def test_builtin_owned_kb_cannot_be_deleted(owned_seed_home):
    seed.ensure_builtin_owned_knowledge()
    with pytest.raises(ValueError, match="内置"):
        owned_service.delete_base(seed.BUILTIN_OWNED_USER_GUIDE_KB_ID)


def test_ensure_adopts_migrated_user_guide_and_dedupes(owned_seed_home):
    """Migration-created「EvoFlow 用户指南」should be adopted; no second builtin."""
    migrated = owned_service.create_base(
        {
            "name": bv.BUILTIN_USER_GUIDE_VAULT_NAME,
            "description": "从 Obsidian Vault 迁移",
            "summaryEnabled": False,
        }
    )
    owned_service.upload_manual_markdown(
        migrated["id"],
        title="旧迁移笔记",
        content="# 迁移内容\n\n旧副本。\n",
        folder_path="",
    )
    owned_service.remember_sync_source(
        migrated["id"],
        source_type="vault",
        source_path="/tmp/old",
        vault_id=bv.BUILTIN_USER_GUIDE_VAULT_ID,
    )

    # Simulate prior seed that also created the stable id base.
    seed._create_fresh_builtin_base()
    assert owned_service.get_base(seed.BUILTIN_OWNED_USER_GUIDE_KB_ID) is not None

    result = seed.ensure_builtin_owned_knowledge()
    assert result["ok"] is True

    active = [
        b
        for b in owned_service.list_bases()
        if b.get("name") == bv.BUILTIN_USER_GUIDE_VAULT_NAME or b.get("builtin")
    ]
    assert len(active) == 1
    assert active[0]["id"] == seed.BUILTIN_OWNED_USER_GUIDE_KB_ID
    assert active[0]["builtin"] is True
    # Migrated copy soft-deleted
    assert owned_service.get_base(migrated["id"]) is None
