"""Filesystem keyword search + interactive MCP wait behavior."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from evoflow.knowledge.vault.errors import ToolTimeoutError
from evoflow.knowledge.vault.fs_search import filesystem_keyword_search, tokenize_query
from evoflow.knowledge.vault import mcp_runtime as rt
from evoflow.knowledge.vault.models import AccessMode, KnowledgeVaultConfig
from evoflow.knowledge.vault.provider import ObsidianKnowledgeProvider


def test_tokenize_query_keeps_cjk_and_words():
    toks = tokenize_query("知识库 hybrid search")
    assert "知识库" in toks or any("知识" in t for t in toks)
    assert any("hybrid" in t for t in toks)


def test_filesystem_keyword_search_ranks_title_hits(tmp_path: Path):
    note = tmp_path / "guides" / "vault.md"
    note.parent.mkdir(parents=True)
    note.write_text("# 知识库接入\n\n说明如何连接 Obsidian vault。\n", encoding="utf-8")
    (tmp_path / "other.md").write_text("# unrelated\nnothing here\n", encoding="utf-8")

    hits = filesystem_keyword_search(
        vault_id="v1",
        vault_path=str(tmp_path),
        query="知识库",
        top_k=5,
    )
    assert hits
    assert hits[0].path.endswith("vault.md")
    assert hits[0].provider == "filesystem"
    assert "知识库" in (hits[0].snippet or hits[0].title)


def test_search_falls_back_when_mcp_still_warming(tmp_path: Path):
    provider = ObsidianKnowledgeProvider()
    note = tmp_path / "a.md"
    note.write_text("# 小V\n全局助手说明\n", encoding="utf-8")
    cfg = KnowledgeVaultConfig.model_validate(
        {
            "id": "personal",
            "name": "personal",
            "vaultPath": str(tmp_path),
            "enabled": True,
            "accessMode": AccessMode.read_only.value,
        }
    )

    async def _run():
        with (
            patch(
                "evoflow.knowledge.vault.provider.vault_store.require_vault_config",
                return_value=cfg,
            ),
            patch(
                "evoflow.knowledge.vault.provider.ensure_session",
                AsyncMock(side_effect=ToolTimeoutError("still starting", details={"warming": True})),
            ),
            patch("evoflow.knowledge.vault.provider.schedule_session_warmup"),
        ):
            return await provider.search("personal", "小V", mode="hybrid", top_k=5)

    hits = asyncio.run(_run())
    assert len(hits) >= 1
    assert hits[0].provider == "filesystem"


def test_failed_search_boot_persists_session_and_accumulates_restarts(tmp_path: Path):
    """Failed MCP boots must persist the session so status stops infinite warming."""
    from evoflow.knowledge.vault.constants import MCP_RESTART_MAX
    from evoflow.knowledge.vault.models import LaunchMode

    cfg = KnowledgeVaultConfig.model_validate(
        {
            "id": "persist-fail",
            "name": "persist-fail",
            "vaultPath": str(tmp_path),
            "enabled": True,
            "accessMode": AccessMode.read_only.value,
            "launchMode": LaunchMode.managed_stdio.value,
        }
    )

    async def _fail_boot(**_kwargs):
        raise RuntimeError("boom")

    async def _run():
        rt._SESSIONS.pop(cfg.id, None)
        rt._BOOT_TASKS.pop(cfg.id, None)
        with patch.object(rt, "_start_with_backoff", AsyncMock(side_effect=_fail_boot)):
            for _ in range(MCP_RESTART_MAX):
                try:
                    await rt.ensure_session(cfg)
                except Exception:
                    pass
        sess = rt.get_session(cfg.id)
        assert sess is not None
        assert sess.search_restarts >= MCP_RESTART_MAX
        assert sess.search_unavailable is True
        assert sess.search_error
        return sess

    asyncio.run(_run())


def test_ensure_session_wait_sec_times_out_while_boot_continues():
    cfg = KnowledgeVaultConfig.model_validate(
        {
            "id": "slow",
            "name": "slow",
            "vaultPath": "/tmp/vault",
            "enabled": True,
            "accessMode": AccessMode.read_only.value,
        }
    )

    async def _slow_body(*_a, **_k):
        await asyncio.sleep(2.0)
        sess = rt.VaultMcpSession(vault_id="slow", search_tools={"search": object()})
        rt._SESSIONS["slow"] = sess
        return sess

    async def _run():
        with (
            patch.object(rt, "_SESSIONS", {}),
            patch.object(rt, "_BOOT_TASKS", {}),
            patch.object(rt, "_CLEANUP_DONE", True),
            patch.object(rt, "_ensure_session_body", side_effect=_slow_body),
        ):
            with pytest.raises(ToolTimeoutError):
                await rt.ensure_session(cfg, wait_sec=0.05)
            # Boot task should still be running / eventually finish
            await asyncio.sleep(0.05)
            task = rt._BOOT_TASKS.get("slow")
            assert task is not None
            result = await asyncio.wait_for(task, timeout=3.0)
            assert result.search_tools

    asyncio.run(_run())
