"""Provider tests with mocked MCP tool invocations."""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from evoflow.knowledge.vault.capability import DiscoveredCapabilities
from evoflow.knowledge.vault.errors import NoteConflictError, PathForbiddenError, WriteDisabledError
from evoflow.knowledge.vault.models import KnowledgeVaultConfig
from evoflow.knowledge.vault.provider import ObsidianKnowledgeProvider
from pathlib import Path


def _cfg(tmp_path, **kwargs: Any) -> KnowledgeVaultConfig:
    vault = tmp_path / "vault"
    vault.mkdir(exist_ok=True)
    (vault / ".obsidian").mkdir(exist_ok=True)
    (vault / "00-Inbox").mkdir(exist_ok=True)
    (vault / "Knowledge").mkdir(exist_ok=True)
    base = {
        "id": "personal",
        "name": "personal",
        "vaultPath": str(vault),
        "accessMode": "read_only",
        "launchMode": "managed_stdio",
        "enabled": True,
    }
    base.update(kwargs)
    return KnowledgeVaultConfig.model_validate(base)


def _sess(**kwargs: Any) -> MagicMock:
    sess = MagicMock()
    sess.search_tools = kwargs.get("search_tools") or {"evo_kb_search": MagicMock(), "evo_kb_read": MagicMock()}
    sess.write_tools = kwargs.get("write_tools") or {}
    sess.search_capabilities = kwargs.get("search_capabilities") or DiscoveredCapabilities(
        search_tool="evo_kb_search",
        read_tool="evo_kb_read",
        reindex_tool="evo_kb_reindex",
        status_tool="evo_kb_status",
        schemas={
            "evo_kb_search": {
                "properties": {
                    "query": {},
                    "mode": {},
                    "limit": {},
                    "rerank": {},
                    "tag": {},
                    "scope": {},
                    "threshold": {},
                    "path": {},
                    "related": {},
                    "depth": {},
                    "direction": {},
                    "link_type": {},
                }
            }
        },
    )
    sess.write_capabilities = kwargs.get("write_capabilities")
    sess.search_error = None
    sess.write_error = None
    sess.search_unavailable = False
    sess.write_unavailable = False
    return sess


def test_search_uses_capability_arg_mapping(tmp_path):
    provider = ObsidianKnowledgeProvider()
    cfg = _cfg(tmp_path)
    sess = _sess()
    payload = {
        "content": [
            {
                "type": "text",
                "text": '{"results":[{"path":"Knowledge/Agent Memory.md","title":"Agent Memory","score":0.9,"snippet":"智能体长期记忆"}]}',
            }
        ]
    }
    call = AsyncMock(return_value=payload)

    async def _run():
        with (
            patch("evoflow.knowledge.vault.provider.vault_store.require_vault_config", return_value=cfg),
            patch("evoflow.knowledge.vault.provider.ensure_session", AsyncMock(return_value=sess)),
            patch("evoflow.knowledge.vault.provider.call_tool", call),
        ):
            return await provider.search(
                "personal",
                "怎么让 AI 记住以前项目？",
                mode="hybrid",
                top_k=8,
                tags=["memory"],
                scopes=["Knowledge"],
            )

    hits = asyncio.run(_run())
    assert len(hits) == 1
    assert "Agent Memory" in hits[0].title
    assert call.await_args.args[1] == "evo_kb_search"
    args = call.await_args.args[2]
    assert args["query"]
    assert args.get("tag") == ["memory"] or args.get("tags") == ["memory"]
    assert "scope" in args or "scopes" in args


def test_graph_uses_related_search_not_semantic(tmp_path):
    provider = ObsidianKnowledgeProvider()
    cfg = _cfg(tmp_path)
    sess = _sess()
    related_payload = {
        "results": [
            {"path": "Knowledge/A.md", "title": "A", "depth": 0},
            {"path": "Knowledge/B.md", "title": "B", "depth": 1, "parent": "Knowledge/A.md"},
            {"path": "Knowledge/C.md", "title": "C", "depth": -1, "parent": "Knowledge/A.md"},
        ]
    }
    call = AsyncMock(return_value=related_payload)

    async def _run():
        with (
            patch("evoflow.knowledge.vault.provider.vault_store.require_vault_config", return_value=cfg),
            patch("evoflow.knowledge.vault.provider.ensure_session", AsyncMock(return_value=sess)),
            patch("evoflow.knowledge.vault.provider.call_tool", call),
        ):
            return await provider.graph("personal", "Knowledge/A.md", depth=1, direction="both")

    g = asyncio.run(_run())
    args = call.await_args.args[2]
    assert args.get("related") is True
    assert args.get("path") == "Knowledge/A.md"
    assert "query" not in args  # not semantic search
    assert len(g.nodes) >= 2


def test_write_disabled(tmp_path):
    provider = ObsidianKnowledgeProvider()
    cfg = _cfg(tmp_path, accessMode="read_only")

    async def _run():
        with patch("evoflow.knowledge.vault.provider.vault_store.require_vault_config", return_value=cfg):
            await provider.create_note("personal", "00-Inbox/x.md", "hi")

    with pytest.raises(WriteDisabledError):
        asyncio.run(_run())


def test_create_conflict(tmp_path):
    provider = ObsidianKnowledgeProvider()
    cfg = _cfg(tmp_path, accessMode="read_write", allowedWritePaths=["00-Inbox"])
    existing = tmp_path / "vault" / "00-Inbox" / "New Note.md"
    existing.write_text("old", encoding="utf-8")
    sess = _sess(
        write_tools={"obsidian_write_note": MagicMock()},
        write_capabilities=DiscoveredCapabilities(write_note_tool="obsidian_write_note"),
    )

    async def _run():
        with (
            patch("evoflow.knowledge.vault.provider.vault_store.require_vault_config", return_value=cfg),
            patch("evoflow.knowledge.vault.provider.ensure_session", AsyncMock(return_value=sess)),
        ):
            await provider.create_note("personal", "00-Inbox/New Note.md", "new")

    with pytest.raises(NoteConflictError):
        asyncio.run(_run())


def test_write_path_forbidden(tmp_path):
    provider = ObsidianKnowledgeProvider()
    cfg = _cfg(tmp_path, accessMode="read_write", allowedWritePaths=["00-Inbox"])
    sess = _sess(
        write_tools={"obsidian_write_note": MagicMock()},
        write_capabilities=DiscoveredCapabilities(write_note_tool="obsidian_write_note"),
    )

    async def _run():
        with (
            patch("evoflow.knowledge.vault.provider.vault_store.require_vault_config", return_value=cfg),
            patch("evoflow.knowledge.vault.provider.ensure_session", AsyncMock(return_value=sess)),
        ):
            await provider.create_note("personal", "Knowledge/New Note.md", "x")

    with pytest.raises(PathForbiddenError):
        asyncio.run(_run())


def test_save_note_overwrites_existing_file(tmp_path):
    provider = ObsidianKnowledgeProvider()
    cfg = _cfg(tmp_path, accessMode="read_write", allowedWritePaths=["00-Inbox"])
    note_path = tmp_path / "vault" / "00-Inbox" / "note.md"
    note_path.write_text("# Old\n", encoding="utf-8")

    async def _run():
        with patch("evoflow.knowledge.vault.provider.vault_store.require_vault_config", return_value=cfg):
            with patch.object(provider, "reindex", AsyncMock()) as reindex:
                saved = await provider.save_note("personal", "00-Inbox/note.md", "# New\n")
                assert saved.content == "# New\n"
                assert note_path.read_text(encoding="utf-8") == "# New\n"
                reindex.assert_awaited_once()

    asyncio.run(_run())


def test_read_prefers_filesystem_when_mcp_content_empty(tmp_path):
    """OHS read may return path metadata with empty body — panel must still show disk text."""
    provider = ObsidianKnowledgeProvider()
    cfg = _cfg(tmp_path)
    note_rel = "Knowledge/Agent Memory.md"
    note_path = tmp_path / "vault" / "Knowledge" / "Agent Memory.md"
    note_path.write_text("# Agent Memory\n\n正文来自磁盘\n", encoding="utf-8")
    sess = _sess()
    sess.search_capabilities.schemas["evo_kb_read"] = {
        "properties": {"paths": {}, "path": {}, "related": {}}
    }

    async def _run():
        with (
            patch("evoflow.knowledge.vault.provider.vault_store.require_vault_config", return_value=cfg),
            patch("evoflow.knowledge.vault.provider.get_ready_session", return_value=sess),
            patch("evoflow.knowledge.vault.provider.ensure_session", AsyncMock(return_value=sess)),
            patch(
                "evoflow.knowledge.vault.provider.call_tool",
                AsyncMock(
                    return_value={
                        "notes": [
                            {
                                "path": note_rel,
                                "title": "Agent Memory",
                                "content": "",
                                "backlinks": ["Projects/EvoFlow.md"],
                            }
                        ]
                    }
                ),
            ),
        ):
            return await provider.read("personal", [note_rel])

    notes = asyncio.run(_run())
    assert len(notes) == 1
    assert "正文来自磁盘" in notes[0].content
    assert notes[0].backlinks == ["Projects/EvoFlow.md"]


def test_invalid_provider_response_handled(tmp_path):
    provider = ObsidianKnowledgeProvider()
    cfg = _cfg(tmp_path)
    sess = _sess()

    async def _run():
        with (
            patch("evoflow.knowledge.vault.provider.vault_store.require_vault_config", return_value=cfg),
            patch("evoflow.knowledge.vault.provider.ensure_session", AsyncMock(return_value=sess)),
            patch("evoflow.knowledge.vault.provider.call_tool", AsyncMock(return_value="not-json-but-ok")),
        ):
            return await provider.search("personal", "q")

    hits = asyncio.run(_run())
    assert isinstance(hits, list)


def test_status_reports_mcp_warming_when_session_missing(tmp_path):
    provider = ObsidianKnowledgeProvider()
    cfg = _cfg(tmp_path)
    (Path(cfg.vault_path) / "note.md").write_text("# hi\n", encoding="utf-8")

    async def _run():
        with (
            patch("evoflow.knowledge.vault.provider.vault_store.require_vault_config", return_value=cfg),
            patch("evoflow.knowledge.vault.provider.probe_node_runtime", return_value=MagicMock(node_ok=True)),
            patch("evoflow.knowledge.vault.provider.get_ready_session", return_value=None),
            patch("evoflow.knowledge.vault.provider.get_session", return_value=None),
            patch("evoflow.knowledge.vault.provider.is_session_warming", return_value=False),
            patch("evoflow.knowledge.vault.provider.schedule_session_warmup") as warm,
            patch("evoflow.knowledge.vault.provider.runtime_status_dict", return_value={}),
        ):
            return await provider.status("personal"), warm

    status, warm = asyncio.run(_run())
    assert status.mcp_warming is True
    assert status.mcp_ready is False
    assert status.search_ready is True  # filesystem path still usable
    assert "启动中" in status.message
    warm.assert_called_once()


def test_status_stops_warming_when_search_unavailable(tmp_path):
    provider = ObsidianKnowledgeProvider()
    cfg = _cfg(tmp_path)
    sess = _sess(search_tools={})
    sess.search_tools = {}
    sess.search_unavailable = True
    sess.search_error = "MCP boot failed"
    sess.semantic_ready = None
    sess.embedding_model = None

    async def _run():
        with (
            patch("evoflow.knowledge.vault.provider.vault_store.require_vault_config", return_value=cfg),
            patch("evoflow.knowledge.vault.provider.probe_node_runtime", return_value=MagicMock(node_ok=True)),
            patch("evoflow.knowledge.vault.provider.get_ready_session", return_value=None),
            patch("evoflow.knowledge.vault.provider.get_session", return_value=sess),
            patch("evoflow.knowledge.vault.provider.is_session_warming", return_value=False),
            patch("evoflow.knowledge.vault.provider.schedule_session_warmup") as warm,
            patch("evoflow.knowledge.vault.provider.runtime_status_dict", return_value={}),
        ):
            return await provider.status("personal"), warm

    status, warm = asyncio.run(_run())
    assert status.mcp_warming is False
    assert status.mcp_ready is False
    assert "启动中" not in status.message
    assert "回退本地全文" in status.message
    warm.assert_not_called()
