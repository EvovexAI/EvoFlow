"""Unified ``knowledge(action=…)`` dispatcher tests."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

from evoflow.knowledge.vault.models import AccessMode, KnowledgeVaultConfig
from evoflow.tools.builtins.knowledge_vault_tools import knowledge_tool
from evoflow.tools.tool_aliases import canonical_tool_name


def _vault(vid: str, *, mode: AccessMode = AccessMode.read_only) -> KnowledgeVaultConfig:
    return KnowledgeVaultConfig.model_validate(
        {
            "id": vid,
            "name": vid,
            "vaultPath": "/tmp/vault",
            "enabled": True,
            "accessMode": mode.value,
        }
    )


def test_legacy_tool_names_alias_to_knowledge():
    for name in (
        "knowledge_search",
        "knowledge_read",
        "knowledge_graph",
        "knowledge_status",
        "knowledge_write",
        "knowledge_ingest",
    ):
        assert canonical_tool_name(name) == "knowledge"
    assert canonical_tool_name("knowledge") == "knowledge"


def test_invalid_action():
    raw = asyncio.run(knowledge_tool.ainvoke({"action": "explode"}))
    data = json.loads(raw)
    assert data["error"] == "invalid_args"


def test_list_action_dispatches():
    listed = {
        "vaultId": "docs",
        "total": 2,
        "count": 2,
        "truncated": False,
        "items": [
            {"path": "a.md", "title": "A", "score": None, "snippet": "a.md", "tags": []},
            {"path": "b.md", "title": "B", "score": None, "snippet": "b.md", "tags": []},
        ],
    }
    with (
        patch(
            "evoflow.tools.builtins.knowledge_vault_tools.vault_store.list_vault_configs",
            return_value=[_vault("docs")],
        ),
        patch(
            "evoflow.tools.builtins.knowledge_vault_tools.vault_service.list_notes",
            return_value=listed,
        ) as list_notes,
    ):
        raw = asyncio.run(knowledge_tool.ainvoke({"action": "list"}))
    data = json.loads(raw)
    assert data["action"] == "list"
    assert data["count"] == 2
    assert data["vaultId"] == "docs"
    list_notes.assert_called_once_with("docs", limit=80, prefix="")


def test_search_action_dispatches():
    hit = MagicMock()
    hit.model_dump.return_value = {"path": "a.md", "title": "A", "score": 1.0}

    provider = MagicMock()
    provider.search = AsyncMock(return_value=[hit])

    with (
        patch(
            "evoflow.tools.builtins.knowledge_vault_tools.vault_store.list_vault_configs",
            return_value=[_vault("docs")],
        ),
        patch(
            "evoflow.tools.builtins.knowledge_vault_tools.get_knowledge_provider",
            return_value=provider,
        ),
    ):
        raw = asyncio.run(
            knowledge_tool.ainvoke({"action": "search", "query": "quick-start", "top_k": 5})
        )
    data = json.loads(raw)
    assert data["action"] == "search"
    assert data["count"] == 1
    assert data["vaultId"] == "docs"
    provider.search.assert_awaited_once()


def test_write_rejected_when_only_read_only_vault():
    with patch(
        "evoflow.tools.builtins.knowledge_vault_tools.vault_store.list_vault_configs",
        return_value=[_vault("ro", mode=AccessMode.read_only)],
    ):
        raw = asyncio.run(
            knowledge_tool.ainvoke(
                {
                    "action": "write",
                    "operation": "create",
                    "path": "00-Inbox/x.md",
                    "content": "hi",
                }
            )
        )
    data = json.loads(raw)
    assert data["error"] == "knowledge_read_only"


def test_knowledge_tool_risk_by_action():
    from evoflow.agents.tool_approval_config import RISK_AUTO, RISK_CONFIRM, RISK_SESSION, tool_risk_level

    assert tool_risk_level("knowledge", {"action": "search"}) == RISK_AUTO
    assert tool_risk_level("knowledge", {"action": "list"}) == RISK_AUTO
    assert tool_risk_level("knowledge", {"action": "ingest"}) == RISK_SESSION
    assert (
        tool_risk_level(
            "knowledge",
            {"action": "write", "operation": "patch", "path": "notes/a.md"},
        )
        == RISK_CONFIRM
    )
    assert tool_risk_level("knowledge_search", {"action": "read"}) == RISK_AUTO
