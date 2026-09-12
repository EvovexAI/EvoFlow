"""Builtin Knowledge Vaults: user-guide + 运营知识库."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.knowledge.vault import builtin as bv
from evoflow.knowledge.vault import service as vault_service
from evoflow.knowledge.vault import store as vault_store
from evoflow.persistence.db import reset_db_for_tests


@pytest.fixture
def vault_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    home = tmp_path / "home"
    home.mkdir()
    src = tmp_path / "docs_user"
    src.mkdir()
    (src / "README.md").write_text("# User guide\n\nHow to use EvoFlow.\n", encoding="utf-8")
    (src / "guides").mkdir()
    (src / "guides" / "quick.md").write_text("# Quick start\n\nInstall then open panel.\n", encoding="utf-8")

    ops = tmp_path / "docs_knowledge"
    ops.mkdir()
    (ops / "README.md").write_text("# 运营知识库\n\n选题与平台规则。\n", encoding="utf-8")
    (ops / "06-平台规则-PLATFORM_RULE").mkdir()
    (ops / "06-平台规则-PLATFORM_RULE" / "03-抖音.md").write_text(
        "# 抖音算法\n\n完播优先。\n", encoding="utf-8"
    )

    monkeypatch.setenv("EVOFLOW_HOME", str(home))
    monkeypatch.setattr(bv, "bundled_user_guide_src", lambda: src)
    monkeypatch.setattr(bv, "contentos_ops_knowledge_src", lambda: ops)
    monkeypatch.setattr(bv, "bundled_ops_knowledge_src", lambda: ops)
    reset_db_for_tests()
    yield home, src, ops
    reset_db_for_tests()


def test_materialize_and_register_builtin_vaults(vault_home) -> None:
    home, src, ops = vault_home
    result = bv.ensure_builtin_knowledge_vaults()
    assert result["ok"] is True
    assert result["vaultId"] == bv.BUILTIN_USER_GUIDE_VAULT_ID
    assert len(result["vaults"]) == 2

    dest = Path(result["vaultPath"])
    assert dest.is_dir()
    assert (dest / "README.md").is_file()
    assert (dest / "guides" / "quick.md").is_file()
    assert (dest / ".obsidian" / "app.json").is_file()
    assert (dest / ".vault_source").read_text(encoding="utf-8").startswith("bundled:")

    cfg = vault_store.get_vault_config(bv.BUILTIN_USER_GUIDE_VAULT_ID)
    assert cfg is not None
    assert cfg.builtin is True
    assert cfg.access_mode.value == "read_only"
    assert cfg.enabled is True
    assert Path(cfg.vault_path) == dest

    ops_cfg = vault_store.get_vault_config(bv.BUILTIN_OPS_KNOWLEDGE_VAULT_ID)
    assert ops_cfg is not None
    assert ops_cfg.builtin is True
    assert ops_cfg.name == bv.BUILTIN_OPS_KNOWLEDGE_VAULT_NAME
    assert ops_cfg.access_mode.value == "read_write"
    assert Path(ops_cfg.vault_path) == ops.resolve()
    assert (Path(ops_cfg.vault_path) / "06-平台规则-PLATFORM_RULE" / "03-抖音.md").is_file()

    again = bv.ensure_builtin_knowledge_vaults()
    assert again["action"] == "unchanged"
    ops_again = next(v for v in again["vaults"] if v["vaultId"] == bv.BUILTIN_OPS_KNOWLEDGE_VAULT_ID)
    assert ops_again["action"] == "unchanged"


def test_refresh_when_source_changes(vault_home) -> None:
    _home, src, _ops = vault_home
    first = bv.ensure_builtin_knowledge_vaults()
    assert first["contentUpdated"] is True
    assert bv.BUILTIN_USER_GUIDE_VAULT_ID in first["needsReindex"]

    unchanged = bv.ensure_builtin_knowledge_vaults()
    assert unchanged["contentUpdated"] is False
    assert bv.BUILTIN_USER_GUIDE_VAULT_ID not in unchanged["needsReindex"]

    (src / "guides" / "new.md").write_text("# New\n\nUpdated docs.\n", encoding="utf-8")
    again = bv.ensure_builtin_knowledge_vaults()
    assert again["contentUpdated"] is True
    assert bv.BUILTIN_USER_GUIDE_VAULT_ID in again["needsReindex"]
    dest = Path(again["vaultPath"])
    assert (dest / "guides" / "new.md").is_file()


def test_schedule_builtin_reindex_after_update(vault_home, monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    bv.ensure_builtin_knowledge_vaults()
    called: list[str] = []

    async def _fake_start(vault_id, **kwargs):
        called.append(vault_id)

        class _Job:
            job_id = "job1"

        return _Job()

    monkeypatch.setattr(
        "evoflow.knowledge.vault.reindex_jobs.start_reindex_job",
        _fake_start,
    )
    started = asyncio.run(bv.schedule_builtin_vault_reindex([bv.BUILTIN_USER_GUIDE_VAULT_ID]))
    assert called == [bv.BUILTIN_USER_GUIDE_VAULT_ID]
    assert started and started[0]["ok"] is True


def test_builtin_vault_cannot_be_deleted(vault_home) -> None:
    import asyncio

    bv.ensure_builtin_knowledge_vaults()
    with pytest.raises(ValueError, match="不可删除"):
        asyncio.run(vault_service.delete_vault(bv.BUILTIN_USER_GUIDE_VAULT_ID))
    with pytest.raises(ValueError, match="不可删除"):
        asyncio.run(vault_service.delete_vault(bv.BUILTIN_OPS_KNOWLEDGE_VAULT_ID))


def test_create_rejects_reserved_builtin_id(vault_home) -> None:
    home, _src, _ops = vault_home
    fake = home / "other"
    fake.mkdir()
    with pytest.raises(ValueError, match="内置"):
        vault_service.create_vault(
            {
                "id": bv.BUILTIN_USER_GUIDE_VAULT_ID,
                "name": "hack",
                "vaultPath": str(fake),
            }
        )
    with pytest.raises(ValueError, match="内置"):
        vault_service.create_vault(
            {
                "id": bv.BUILTIN_OPS_KNOWLEDGE_VAULT_ID,
                "name": "hack",
                "vaultPath": str(fake),
            }
        )
