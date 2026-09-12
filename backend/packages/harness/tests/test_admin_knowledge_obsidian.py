"""Obsidian-backed ``evoflow knowledge`` admin CLI."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.admin import knowledge as knowledge_admin
from evoflow.admin.errors import ValidationError
from evoflow.knowledge.vault.builtin import BUILTIN_USER_GUIDE_VAULT_ID
from evoflow.knowledge.vault.models import AccessMode, KnowledgeVaultConfig, ProviderType
from evoflow.knowledge.vault import store as vault_store
from evoflow.persistence.db import reset_db_for_tests


@pytest.fixture
def vault_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("EVOFLOW_HOME", str(home))
    reset_db_for_tests()

    src = tmp_path / "docs_user"
    src.mkdir()
    (src / "README.md").write_text("# 用户指南\n\n这是关于知识库的说明。\n", encoding="utf-8")
    guides = src / "guides"
    guides.mkdir()
    (guides / "knowledge-vault.md").write_text(
        "# 知识库\n\n连接 Obsidian Vault 做检索。\n",
        encoding="utf-8",
    )

    # Skip package sync; point builtin materialize at our fixture tree.
    monkeypatch.setattr(
        "evoflow.knowledge.vault.builtin.bundled_user_guide_src",
        lambda: src,
    )
    monkeypatch.setattr(
        "evoflow.knowledge.vault.builtin.ensure_builtin_knowledge_vaults",
        lambda: {
            "ok": True,
            "action": "test",
            "vaultId": BUILTIN_USER_GUIDE_VAULT_ID,
            "vaultPath": str(src),
        },
    )

    cfg = KnowledgeVaultConfig.model_validate(
        {
            "id": BUILTIN_USER_GUIDE_VAULT_ID,
            "name": "EvoFlow 用户指南",
            "enabled": True,
            "builtin": True,
            "providerType": ProviderType.obsidian.value,
            "vaultPath": str(src),
            "accessMode": AccessMode.read_only.value,
        }
    )
    vault_store.upsert_vault_config(cfg)

    rw = tmp_path / "rw_vault"
    rw.mkdir()
    (rw / "note.md").write_text("# keep\n", encoding="utf-8")
    vault_store.upsert_vault_config(
        KnowledgeVaultConfig.model_validate(
            {
                "id": "my-notes",
                "name": "My Notes",
                "enabled": True,
                "vaultPath": str(rw),
                "accessMode": AccessMode.read_write.value,
            }
        )
    )

    yield home, src, rw
    reset_db_for_tests()


def test_recall_searches_obsidian_vault(vault_env) -> None:
    _home, _src, _rw = vault_env
    out = knowledge_admin.recall("知识库", vault_id=BUILTIN_USER_GUIDE_VAULT_ID, mode="fulltext", limit=5)
    assert out["vaultId"] == BUILTIN_USER_GUIDE_VAULT_ID
    assert out["total"] >= 1
    paths = [e.get("path") for e in out["entries"]]
    assert any(p and "knowledge-vault" in str(p) for p in paths)


def test_list_and_get_notes(vault_env) -> None:
    out = knowledge_admin.list_knowledge(vault_id=BUILTIN_USER_GUIDE_VAULT_ID, limit=50)
    assert out["total"] >= 2
    note = knowledge_admin.get_knowledge("guides/knowledge-vault.md", vault_id=BUILTIN_USER_GUIDE_VAULT_ID)
    assert "知识库" in str(note["item"].get("content") or note["item"].get("title") or "")


def test_remember_requires_read_write(vault_env) -> None:
    with pytest.raises(ValidationError, match="只读"):
        knowledge_admin.remember(
            {"title": "x", "knowledge": "y"},
            vault_id=BUILTIN_USER_GUIDE_VAULT_ID,
        )


def test_delete_note_on_read_write_vault(vault_env) -> None:
    _home, _src, rw = vault_env
    assert (rw / "note.md").is_file()
    out = knowledge_admin.delete_knowledge("note.md", vault_id="my-notes")
    assert out["ok"] is True
    assert not (rw / "note.md").exists()
